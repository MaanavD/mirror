import {fresh, instant, dateKey, timeLabel, allEvents, MINUTE} from './attention.js';

export function lightingFor(entry, now=Date.now()) {
  const lights=fresh(entry,'nanoleaf',now)?entry.data?.lights:[];
  return [['light.shapes_a418','Flower'],['light.shapes_dedf','Bedstagons']].map(([id,name])=>{
    const light=lights?.find(light=>light.entityId===id);
    const status=light?.on===true?'on':light?.on===false?'off':'unknown';
    const percent=status==='on'&&Number.isFinite(light.brightness)?Math.round(Math.max(0,Math.min(255,light.brightness))/255*100):null;
    return {id,name:light?.name??name,status,percent};
  });
}

export function localInstant(day, hour, zone) {
  const [y,m,d]=day.split('-').map(Number);
  const target=Date.UTC(y,m-1,d,hour);
  let value=target;
  for(let i=0;i<3;i++){
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(value).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
    const rendered=Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute,parts.second);
    value+=target-rendered;
  }
  return value;
}
const previousDay=day=>new Date(Date.parse(day+'T12:00:00Z')-86400000).toISOString().slice(0,10);

export function isWorkoutEvent(event) {
  if(event?.kind==='workout'||event?.type==='workout')return true;
  const title=String(event?.title??'').trim();
  return /^(?:(?:morning|evening|afternoon)\s+)?(?:workout|gym|strength training|weight training|cardio|yoga|pilates|exercise)(?:$|\b\s*[:—–-]|\s+(?:session|class|at|with)\b)/i.test(title)
    || /^lift\s*[:—–-]\s*(?:push|pull|legs|upper|lower|full body)\b/i.test(title)
    || /^(?:(?:morning|evening)\s+)?(?:run|running|zone\s*2)(?:$|\s+\d|\s*[:—–-])/i.test(title);
}

export function showTimeline(state,now=Date.now()) {
  const calendar=state?.modules?.calendar;
  const zone=calendar?.data?.timeZone??'America/Los_Angeles';
  const weekday=new Intl.DateTimeFormat('en-US',{timeZone:zone,weekday:'short'}).format(now);
  if(!['Sat','Sun'].includes(weekday))return true;
  if(!fresh(calendar,'calendar',now)||calendar.data?.configured===false)return false;
  const today=dateKey(now,zone);
  return allEvents(calendar.data).some(e=>{
    if(isWorkoutEvent(e))return false;
    const start=instant(e.start),end=instant(e.end);
    return dateKey(start,zone)<=today&&dateKey(Number.isFinite(end)&&end>start?end-1:start,zone)>=today;
  });
}
export function wakingWindow(entry, now, zone) {
  const w=fresh(entry,'wellness',now)?entry.data?.dayWindow:null;
  const start=instant(w?.wakeAt);
  const explicitEnd=instant(w?.bedtimeAt);
  const validEnd=Number.isFinite(explicitEnd)&&explicitEnd>start&&explicitEnd-start<=24*60*MINUTE;
  const end=validEnd?explicitEnd:Number.isFinite(start)?localInstant(dateKey(start,zone),24,zone):NaN;
  if(Number.isFinite(start)&&Number.isFinite(end)&&end>start&&end-start<=24*60*MINUTE&&now-start>=-6*60*MINUTE&&now-start<24*60*MINUTE){
    return {start,end,estimated:Boolean(w.estimated)||!validEnd,wakeLabel:w.wakeSource==='eight_sleep'?'Woke':'Wake',
      sleepLabel:validEnd?(w.bedtimeSource==='eight_sleep'?'Bedtime':'Suggested sleep'):'Sleep ~',source:w.wakeSource==='eight_sleep'?`Eight Sleep wake${validEnd?'':' · sleep estimated'}`:'Estimated day'};
  }
  let day=dateKey(now,zone);
  if(now<localInstant(day,4,zone))day=previousDay(day);
  return {start:localInstant(day,9,zone),end:localInstant(day,24,zone),estimated:true,wakeLabel:'Wake ~',sleepLabel:'Sleep ~',source:'Estimated day · sleep data unavailable'};
}

export function timelineFor(state, now=Date.now()) {
  const m=state?.modules??{},zone=m.calendar?.data?.timeZone??'America/Los_Angeles';
  const window=wakingWindow(m.wellness,now,zone);
  const calendarReady=fresh(m.calendar,'calendar',now)&&m.calendar.data?.configured!==false&&m.calendar.data?.coverageComplete!==false;
  const events=calendarReady?allEvents(m.calendar.data).filter(e=>!e.allDay&&e.busy!==false&&e.transparency!=='transparent')
    .map(e=>({...e,start:Math.max(window.start,instant(e.start)),end:Math.min(window.end,instant(e.end))}))
    .filter(e=>e.end>e.start).sort((a,b)=>a.start-b.start):[];
  const busy=[];
  for(const e of events){const last=busy.at(-1);if(last&&e.start<=last.end){last.end=Math.max(last.end,e.end);last.titles.push(e.title);}else busy.push({start:e.start,end:e.end,titles:[e.title]});}
  const gaps=[];
  if(calendarReady){let cursor=window.start;for(const b of busy){if(b.start>cursor)gaps.push({start:cursor,end:b.start});cursor=b.end;}if(cursor<window.end)gaps.push({start:cursor,end:window.end});}
  const nextGap=gaps.map(g=>({...g,start:Math.max(g.start,now)})).find(g=>g.end-g.start>=15*MINUTE)??null;
  return {...window,zone,events,busy,gaps,nextGap,calendarReady,nowFraction:Math.max(0,Math.min(1,(now-window.start)/(window.end-window.start)))};
}

export function prioritiesFor(state,now=Date.now()) {
  const m=state?.modules??{},zone=m.calendar?.data?.timeZone??'America/Los_Angeles',today=dateKey(now,zone);
  const tasks=[];
  for(const [module,source] of [['notion','personal'],['workboard','work']]){
    const entry=m[module];
    if(!fresh(entry,module,now)||entry.data?.configured===false)continue;
    for(const item of entry.data?.items??[]){
      const status=String(item.status??'').trim().toLowerCase();
      if(item.done||/^(done|completed|trashed|archived|blocked|agent working|backlog)$/.test(status))continue;
      const due=item.due&&Number.isFinite(instant(item.due))?(String(item.due).length===10?item.due:dateKey(instant(item.due),zone)):null;
      const delta=due?(Date.parse(due)-Date.parse(today))/86400000:NaN;
      let score=20,reason=source==='work'?'Command Board':'Personal task';
      if(/active|in progress/.test(status)){score=70;reason='In progress';}
      if(status==='review'){score=85;reason='Ready for your review';}
      if(delta===0){score=95;reason='Due today';}
      else if(delta<0&&delta>=-7&&75+delta>score){score=75+delta;reason='Recent overdue task';}
      else if(delta>0&&delta<=2&&score<60){score=60-delta;reason=delta===1?'Due tomorrow':'Due soon';}
      else if(delta<-14&&score<70){score=5;reason='Older reminder';}
      if(item.priority && /urgent|high|p0|p1/i.test(item.priority)){score+=10;reason='High priority';}
      tasks.push({...item,source,score,reason});
    }
  }
  return tasks.sort((a,b)=>b.score-a.score||String(a.due??'9999').localeCompare(String(b.due??'9999'))||String(a.id).localeCompare(String(b.id)));
}

export function comfortFor(entry,now=Date.now(),zone='America/Los_Angeles') {
  if(!fresh(entry,'weather',now))return null;
  const d=entry.data??{},current=d.current?.temp;
  const hours=(d.hours??[]).filter(h=>instant(h.at)>=now&&dateKey(instant(h.at),zone)===dateKey(now,zone));
  const precipitation=hours.find(h=>h.code>=51&&h.code<=99);
  if(precipitation){
    const kind=precipitation.code>=95?'Thunderstorms':(precipitation.code>=71&&precipitation.code<=77)||precipitation.code===85||precipitation.code===86?'Snow':'Rain';
    return `${kind} ${instant(precipitation.at)-now<60*MINUTE?'soon':`around ${timeLabel(instant(precipitation.at),zone)}`}`;
  }
  const temperatures=hours.map(h=>h.temp).filter(Number.isFinite);
  if(!Number.isFinite(current)||!temperatures.length)return null;
  const high=Math.max(...temperatures),low=Math.min(...temperatures);
  if(high-current>=5)return `Warming to ${Math.round(high)}° later`;
  if(current-low>=5)return `Cooling to ${Math.round(low)}° later`;
  if(low<=10&&current<=12)return 'A cool stretch ahead';
  return null;
}

// Keep both boards visible when their priorities are close; a clearly more
// urgent task still wins. No user-maintained mirror tags are required.
export function focusTasks(state,now=Date.now(),limit=2) {
  const ranked=prioritiesFor(state,now);
  if(limit<2||ranked.length<2)return ranked.slice(0,limit);
  const other=ranked.find(t=>t.source!==ranked[0].source&&t.score>=ranked[1].score-15);
  return (other?[ranked[0],other,...ranked.filter(t=>t!==ranked[0]&&t!==other)]:ranked).slice(0,limit);
}

export function briefFor(state,now=Date.now()) {
  const t=timelineFor(state,now),tasks=prioritiesFor(state,now);
  const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:t.zone,hour:'numeric',hourCycle:'h23'}).format(now));
  const events=t.calendarReady?allEvents(state.modules.calendar.data).filter(e=>!e.allDay&&instant(e.start)>now):[];
  const next=events[0];
  const label=hour<4||hour>=20?'Looking ahead':hour<12?'Your morning':'A little focus';
  if(hour<4||hour>=20){
    const nextDay=next?dateKey(instant(next.start),t.zone):null;
    const tomorrow=new Date(Date.parse(dateKey(now,t.zone)+'T12:00:00Z')+86400000).toISOString().slice(0,10);
    const nextLabel=!next?label:nextDay===dateKey(now,t.zone)?'Later today':nextDay===tomorrow?'Tomorrow':new Intl.DateTimeFormat('en-US',{timeZone:t.zone,weekday:'long'}).format(instant(next.start));
    return {label:nextLabel,title:next?`${timeLabel(instant(next.start),t.zone)} · ${next.title}`:'Room to wind down',
      detail:next?'Next on your calendar':'Your tasks will be here when you’re ready.'};
  }
  if(t.nextGap&&t.nextGap.start<=now){
    const minutes=Math.floor((t.nextGap.end-now)/MINUTE),hours=Math.floor(minutes/60);
    const duration=hours?`${hours}h${minutes%60?` ${minutes%60}m`:''}`:`${minutes} minutes`;
    const fitting=tasks.find(task=>Number.isFinite(task.effortMinutes)&&task.effortMinutes>0&&task.effortMinutes<=minutes-5);
    const nextBlock=t.busy.find(b=>b.start>=t.nextGap.end);
    return {label:'Room in your day',title:`${duration} ${nextBlock?'before your next block':'open on your calendar'}`,detail:fitting?`${fitting.effortMinutes} min · ${fitting.title}`:nextBlock?`Next: ${nextBlock.titles[0]}`:'Your evening has room to breathe.'};
  }
  if(tasks[0])return {label,title:tasks[0].title,detail:tasks[0].reason};
  return {label,title:next?`Next at ${timeLabel(instant(next.start),t.zone)}`:t.calendarReady?'A little room to think':'Calendar unavailable',detail:next?.title??(t.calendarReady?'Nothing timed is coming up.':'Your saved schedule is not current.')};
}
