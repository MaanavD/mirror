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
const nextDay=day=>new Date(Date.parse(day+'T12:00:00Z')+86400000).toISOString().slice(0,10);

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

// Sleep hygiene cutoffs, counted back from the bed time the guard enforces.
// Caffeine is a window (the last cup lands somewhere inside it), the rest are
// deadlines.
export function nightSkincareFor(dayKey) {
  const dayOfWeek = new Date(dayKey + 'T12:00:00Z').getUTCDay();
  if (dayOfWeek === 0) {
    return {
      title: 'Dokdo · Microneedle 0.5mm · Illiyoon',
      sub: 'Pen night: pure HA glide, no Biacna / minox 24h',
    };
  }
  if (dayOfWeek === 5 || dayOfWeek === 6) {
    return {
      title: 'Dokdo · Barrier repair · Illiyoon',
      sub: 'Pre-pen: Biacna paused 48h to prep barrier',
    };
  }
  if (dayOfWeek === 1) {
    return {
      title: 'Dokdo · Barrier repair · Illiyoon',
      sub: 'Post-pen: 24h recovery, no Biacna / no minox',
    };
  }
  return {
    title: 'Dokdo · Biacna gel · Illiyoon',
    sub: 'Pea-sized Biacna across face, buffer with cream',
  };
}

export const SLEEP_CUTOFFS = [
  { id:'caffeine', label:'Last caffeine', offsetMinutes:12*60, untilOffsetMinutes:10*60, rule:'10–12h before bed' },
  { id:'exercise', label:'Finish exercise', offsetMinutes:4*60, rule:'4h before bed' },
  { id:'food', label:'Last meal', offsetMinutes:4*60, rule:'4h before bed' },
  { id:'blue-light', label:'Warm light only', offsetMinutes:2*60, rule:'2h before bed' },
  { id:'screens', label:'Screens away', offsetMinutes:60, rule:'1h before bed' },
  { id:'skincare', label:'Night skincare', offsetMinutes:45, rule:'45m before bed' },
];

export function cutoffsFor(bedAt, now=Date.now(), zone='America/Los_Angeles') {
  if(!Number.isFinite(bedAt))return {cutoffs:[],next:null};
  const skin = nightSkincareFor(dateKey(bedAt - 45 * MINUTE, zone));
  const cutoffs=SLEEP_CUTOFFS.map(d=>{
    const c = {
      ...d,
      at:bedAt-d.offsetMinutes*MINUTE,
      atEnd:d.untilOffsetMinutes!=null?bedAt-d.untilOffsetMinutes*MINUTE:null,
    };
    if (d.id === 'skincare') {
      c.label = skin.title;
      c.sub = skin.sub;
    }
    return c;
  }).map(c=>({...c,past:(c.atEnd??c.at)<now}));
  // A window stays live between its two ends; a deadline until it passes.
  // Exercise and food share a time, so they read as one row.
  const next=cutoffs.find(c=>!c.past)??null;
  return {cutoffs,next};
}

const calendarReady=(m,now)=>fresh(m.calendar,'calendar',now)&&m.calendar.data?.configured!==false&&m.calendar.data?.coverageComplete!==false;
const timedEvents=(m,now)=>calendarReady(m,now)
  ?allEvents(m.calendar.data).filter(e=>!e.allDay&&e.busy!==false&&e.transparency!=='transparent'&&Number.isFinite(instant(e.start)))
  :[];

/**
 * Everything between now and bed, in the order it happens: the current event,
 * what's next, the open stretches between them, the next sleep cutoff, bed.
 * One list, one row grammar — nothing on the glass says the same thing twice.
 *
 * Rows: {kind:'event'|'gap'|'cutoff'|'bed'|'tomorrow', at, end?, title, ...}
 */
export function streamFor(state, now=Date.now(), sleep=null, {allCutoffs=false}={}) {
  const m=state?.modules??{},zone=m.calendar?.data?.timeZone??'America/Los_Angeles';
  const ready=calendarReady(m,now);
  const bedAt=sleep?.bedAt;
  const horizon=Number.isFinite(bedAt)&&bedAt>now?bedAt:localInstant(dateKey(now,zone),24,zone);
  const events=timedEvents(m,now).filter(e=>{
    const start=instant(e.start),end=instant(e.end);
    return (Number.isFinite(end)?end:start+30*MINUTE)>now&&start<horizon;
  });
  const rows=[];
  let cursor=now;
  for(const e of events){
    const start=instant(e.start),end=Number.isFinite(instant(e.end))?instant(e.end):start+30*MINUTE;
    // Stretches of an hour or more between two commitments; the stretch
    // before the first one is what the headline already says.
    if(rows.length&&start-cursor>=60*MINUTE)rows.push({kind:'gap',at:cursor,end:start});
    rows.push({kind:'event',id:e.id,at:start,end,title:e.title,location:e.location??null,now:start<=now&&end>now});
    cursor=Math.max(cursor,end);
  }
  if(ready&&rows.length&&Number.isFinite(bedAt)&&bedAt-cursor>=60*MINUTE)rows.push({kind:'gap',at:cursor,end:bedAt,beforeBed:true});
  if(Number.isFinite(bedAt)&&bedAt>now){
    const {cutoffs,next}=cutoffsFor(bedAt,now,zone);
    const shown=allCutoffs?cutoffs.filter(c=>!c.past):next?[next]:[];
    const seen=new Set();
    for(const c of shown){
      if(seen.has(c.at)){rows.find(r=>r.kind==='cutoff'&&r.at===c.at).title+=` · ${c.label.toLowerCase()}`;continue;}
      seen.add(c.at);
      rows.push({kind:'cutoff',id:c.id,at:c.at,end:c.atEnd,title:c.label,rule:c.rule,sub:c.sub,live:c.at<=now});
    }
    rows.push({kind:'bed',at:bedAt,title:'Bed',basis:sleep.bedBasis,firstMeeting:sleep.firstMeeting});
  }
  rows.sort((a,b)=>(a.kind==='event'&&a.now?-1:0)-(b.kind==='event'&&b.now?-1:0)||a.at-b.at||(a.kind==='bed')-(b.kind==='bed'));
  // Nothing left before bed: the next day's first commitments earn the space.
  const upcoming=rows.some(r=>r.kind==='event');
  const tomorrow=ready&&!upcoming?timedEvents(m,now).filter(e=>instant(e.start)>=horizon).slice(0,2)
    .map(e=>({kind:'tomorrow',id:e.id,at:instant(e.start),end:instant(e.end),title:e.title,location:e.location??null})):[];
  const allDay=ready?allEvents(m.calendar.data).filter(e=>e.allDay&&dateKey(instant(e.start),zone)<=dateKey(now,zone)
    &&dateKey(Number.isFinite(instant(e.end))?instant(e.end)-1:instant(e.start),zone)>=dateKey(now,zone)).map(e=>e.title):[];
  return {rows,tomorrow,allDay,calendarReady:ready,zone};
}

export function durationLabel(ms) {
  const minutes=Math.max(0,Math.round(ms/MINUTE)),h=Math.floor(minutes/60),r=minutes%60;
  return h?`${h}h${r?` ${r}m`:''}`:`${r} min`;
}

/** Last night's own numbers, only while they're news (the morning after). */
export function lastNightFor(state, now=Date.now()) {
  const w=state?.modules?.wellness;
  const night=fresh(w,'wellness',now)?w.data?.dayWindow?.lastNight:null;
  if(!night)return null;
  const wake=instant(night.wakeAt);
  if(!Number.isFinite(wake)||now-wake>6*60*MINUTE||now<wake)return null;
  return {hours:night.durationHours,score:night.score,wakeAt:wake,
    asleep:Number.isFinite(night.durationHours)?durationLabel(night.durationHours*60*MINUTE):null};
}

/**
 * The one sentence at the top of the glass. Returns {tone,label,title,detail}
 * where tone is 'now' | 'soon' | 'next' | 'calm' | 'night'.
 */
export function headlineFor(state, now=Date.now(), sleep=null, stream=streamFor(state,now,sleep)) {
  const zone=stream.zone,t=v=>timeLabel(v,zone);
  const phase=sleep?.phase??'day';
  const current=stream.rows.find(r=>r.kind==='event'&&r.now);
  const next=stream.rows.find(r=>r.kind==='event'&&!r.now);
  if(next&&next.at-now<=15*MINUTE)
    return {tone:'soon',eventId:next.id,label:next.at-now<=MINUTE?'Starting':`In ${Math.max(1,Math.ceil((next.at-now)/MINUTE))} min`,
      title:next.title,detail:[t(next.at),next.location].filter(Boolean).join(' · ')};
  if(current)
    return {tone:'now',eventId:current.id,label:'Now',title:current.title,
      detail:`until ${t(current.end)} · ${durationLabel(current.end-now)} left${next?` · then ${t(next.at)} ${next.title}`:''}`};
  if(phase==='bedtime'||phase==='night')
    return {tone:'night',label:phase==='night'?'Night':'Past bedtime',
      title:`Sleep now: ${durationLabel(sleep.wakeAt-now)}`,
      detail:[`${sleep.wakeBasis==='alarm'?'alarm':'up'} ${t(sleep.wakeAt)}`,
        sleep.firstMeeting?`${t(sleep.firstMeeting.at)} ${sleep.firstMeeting.title}`:null].filter(Boolean).join(' · ')};
  if(phase==='winddown'){
    const {next:cutoff}=cutoffsFor(sleep.bedAt,now);
    return {tone:'calm',label:'Wind down',title:`Bed at ${t(sleep.bedAt)} · in ${durationLabel(sleep.bedAt-now)}`,
      detail:[cutoff&&cutoff.at>now?`${cutoff.label.toLowerCase()} at ${t(cutoff.at)}`:null,
        sleep.firstMeeting?`first up ${t(sleep.firstMeeting.at)} ${sleep.firstMeeting.title}`:'nothing early tomorrow'].filter(Boolean).join(' · ')};
  }
  if(phase==='morning'){
    // Last night's numbers open the stream below; the headline is the day.
    return {tone:'calm',eventId:next?.id,label:'Good morning',title:next?`${t(next.at)} ${next.title}`:'Nothing on the calendar',
      detail:next?`first up in ${durationLabel(next.at-now)}${next.location?` · ${next.location}`:''}`:'a clear day'};
  }
  if(next)
    return {tone:'next',eventId:next.id,label:'Next',title:next.title,
      detail:[t(next.at),`in ${durationLabel(next.at-now)}`,next.location].filter(Boolean).join(' · ')};
  if(!stream.calendarReady)return {tone:'calm',label:'Calendar',title:'Calendar is catching up',detail:'events return when it reconnects'};
  const first=stream.tomorrow[0];
  return {tone:'calm',label:'Clear',title:Number.isFinite(sleep?.bedAt)?`Free until bed at ${t(sleep.bedAt)}`:'Nothing else today',
    detail:first?`tomorrow ${t(first.at)} ${first.title}`:'nothing on tomorrow yet'};
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
