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

export function localInstant(day, hour, zone, minute = 0) {
  const [y,m,d]=day.split('-').map(Number);
  const target=Date.UTC(y,m-1,d,hour,minute);
  let value=target;
  for(let i=0;i<3;i++){
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(value).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
    const rendered=Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute,parts.second);
    value+=target-rendered;
  }
  return value;
}
const previousDay=day=>new Date(Date.parse(day+'T12:00:00Z')-86400000).toISOString().slice(0,10);
const nextDay=day=>new Date(Date.parse(day+'T12:00:00Z')+86400000).toISOString().slice(0,10);

const SLEEP_CUTOFFS = [
  { id:'caffeine', label:'Caffeine', icon:'◒', offsetMinutes:12*60, untilOffsetMinutes:10*60, rule:'10-12h before sleep' },
  { id:'exercise', label:'Exercise done by', icon:'✦', offsetMinutes:4*60, rule:'finish 4-6h before sleep' },
  { id:'food', label:'Eating done by', icon:'◈', offsetMinutes:4*60, rule:'finish 4h before sleep' },
  { id:'blue-light', label:'Blue light off', icon:'☼', offsetMinutes:2*60, rule:'avoid for the last 2h' },
  { id:'screens', label:'Screens off', icon:'▣', offsetMinutes:60, rule:'screens off 1h before sleep' },
];
const NON_MEETING = /\b(?:workout|gym|lift|strength training|weight training|cardio|yoga|pilates|run(?:ning)?|zone\s*2|bouldering|climb(?:ing)?|dance(?:\s+practice)?|laundry|shower|drive|commute|walk|breakfast|lunch|dinner|appointment|reservation|errand|sleep|bed|mirror work)\b/i;

function likelyMeeting(event) {
  return Boolean(event && !event.allDay && event.busy !== false
    && Number.isFinite(instant(event.start)) && !NON_MEETING.test(String(event.title ?? '').trim()));
}

export function firstMeetingTomorrow(calendarEntry, now=Date.now(), zone='America/Los_Angeles') {
  const data=calendarEntry?.data ?? calendarEntry;
  if(!data || data.configured===false || data.coverageComplete===false) return null;
  const tomorrow=nextDay(dateKey(now,zone));
  return allEvents(data)
    .filter(event=>dateKey(instant(event.start),zone)===tomorrow && likelyMeeting(event))
    .sort((a,b)=>instant(a.start)-instant(b.start))[0] ?? null;
}

// Eight Sleep "last night" stats only describe the night just finished. They
// are useful right after waking; by evening the same-day plan matters more, so
// the mirror swaps them out once the next cutoff is still hours away.
function nightField(now,zone,sleepAt) {
  const firstCutoffAt=Math.min(...SLEEP_CUTOFFS.map(d=>sleepAt-d.offsetMinutes*MINUTE));
  // Morning with the first cutoff still ≥4h out → show last-night stats.
  if(now>=sleepAt&&now<firstCutoffAt-4*60*MINUTE)return true;
  // Tight night (cutoff passed but we only just woke) → still show them.
  if(now<firstCutoffAt&&now-sleepAt>=0&&now-sleepAt<3*60*MINUTE)return true;
  return false;
}

export function sleepPlanFor(calendarEntry, now=Date.now(), zone='America/Los_Angeles', night=null) {
  const calendarReady=fresh(calendarEntry,'calendar',now)
    && calendarEntry?.data?.configured!==false
    && calendarEntry?.data?.coverageComplete!==false;
  const meeting=calendarReady ? firstMeetingTomorrow(calendarEntry,now,zone) : null;
  const tomorrow=nextDay(dateKey(now,zone));
  const sleepAt=meeting
    ? instant(meeting.start)-8.5*60*MINUTE
    : localInstant(tomorrow,0,zone,30);
  if(!Number.isFinite(sleepAt)) return null;
  const cutoffs=SLEEP_CUTOFFS.map(definition=>({
    ...definition,
    at:sleepAt-definition.offsetMinutes*MINUTE,
    atEnd:definition.untilOffsetMinutes!=null?sleepAt-definition.untilOffsetMinutes*MINUTE:null,
    past:sleepAt-definition.offsetMinutes*MINUTE<now,
  }));
  // Ranges (caffeine 8-10h) stay relevant between their two ends; passed-only
  // cutoffs stay relevant until the next cutoff arrives, so an already-done
  // routine doesn't flash on the mirror at 8pm for a midnight bedtime.
  // Next cutoff: the earliest deadline still ahead — a range counts while
  // now is inside it, and past-only cutoffs hand off to the next deadline.
  const nextCutoff=cutoffs.find(cutoff=>cutoff.at>=now||(cutoff.atEnd!=null&&now<cutoff.atEnd)) ?? null;
  const field=nightField(now,zone,sleepAt)?night??null:null;
  return {
    sleepAt,
    sleepLabel:timeLabel(sleepAt,zone),
    calendarReady,
    meeting:meeting ? { title:meeting.title, at:instant(meeting.start) } : null,
    basis:meeting ? `First meeting ${timeLabel(instant(meeting.start),zone)}` : calendarReady ? 'No meeting tomorrow' : 'Calendar unavailable',
    cutoffs,
    nextCutoff:nextCutoff ?? null,
    night:field,
  };
}

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
// The configured bed time (wellness profile, 23:30 by default) is a target, not
// a measurement, so it only bounds the window when Eight Sleep gave no bedtime
// and the target actually falls after the wake.
function targetEndInstant(w, start, zone) {
  const minutes=Number(w?.sleepTargetMinutes);
  if(!Number.isFinite(minutes)||minutes<0||minutes>=24*60||!Number.isFinite(start))return NaN;
  const at=localInstant(dateKey(start,zone),Math.floor(minutes/60),zone,minutes%60);
  return Number.isFinite(at)&&at>start?at:NaN;
}
export function wakingWindow(entry, now, zone) {
  const w=fresh(entry,'wellness',now)?entry.data?.dayWindow:null;
  const start=instant(w?.wakeAt);
  const explicitEnd=instant(w?.bedtimeAt);
  const validEnd=Number.isFinite(explicitEnd)&&explicitEnd>start&&explicitEnd-start<=24*60*MINUTE;
  const targetEnd=validEnd?NaN:targetEndInstant(w,start,zone);
  const end=validEnd?explicitEnd:Number.isFinite(targetEnd)?targetEnd:Number.isFinite(start)?localInstant(dateKey(start,zone),24,zone):NaN;
  if(Number.isFinite(start)&&Number.isFinite(end)&&end>start&&end-start<=24*60*MINUTE&&now-start>=-6*60*MINUTE&&now-start<24*60*MINUTE){
    const sleepLabel=validEnd?(w.bedtimeSource==='eight_sleep'?'Bedtime':'Suggested sleep'):Number.isFinite(targetEnd)?'Bed target':'Sleep ~';
    return {start,end,estimated:Boolean(w.estimated)||!validEnd,wakeLabel:w.wakeSource==='eight_sleep'?'Woke':'Wake',
      sleepLabel,
      source:w.wakeSource==='eight_sleep'?`Eight Sleep wake${validEnd?'':Number.isFinite(targetEnd)?` · bed target ${w.sleepTargetClock}`:' · sleep estimated'}`:'Estimated day'};
  }
  let day=dateKey(now,zone);
  if(now<localInstant(day,4,zone))day=previousDay(day);
  const targetWake=targetEndInstant(w,localInstant(day,9,zone),zone);
  return {start:localInstant(day,9,zone),end:Number.isFinite(targetWake)?targetWake:localInstant(day,24,zone),estimated:true,wakeLabel:'Wake ~',
    sleepLabel:Number.isFinite(targetWake)?'Bed target':'Sleep ~',source:'Estimated day · sleep data unavailable'};
}

export function timelineFor(state, now=Date.now()) {
  const m=state?.modules??{},zone=m.calendar?.data?.timeZone??'America/Los_Angeles';
  const plan=sleepPlanFor(m.calendar,now,zone);
  const base=wakingWindow(m.wellness,now,zone);
  const window=plan&&plan.sleepAt>base.start
    ? {...base,end:plan.sleepAt,sleepLabel:'Sleep',source:plan.meeting?`Sleep ${plan.sleepLabel} · ${plan.basis}`:`${plan.basis} · sleep ${plan.sleepLabel}`}
    : base;
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
