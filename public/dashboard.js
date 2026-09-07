import { fresh, ageLabel, dateKey, timeLabel, instant, agendaFor, tasksFor, horizonFor, buildAttention, sunlightFor, MINUTE } from './attention.js?v=9';
import {lightingFor, localInstant, timelineFor, showTimeline, focusTasks, comfortFor, briefFor} from './day-model.js?v=9';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const mirror = params.get('view') === 'mirror';
const example = params.get('example');
const preview = params.get('preview') === '1';
document.body.classList.toggle('mirror', mirror);
const storageKey = 'hermy.brief.preferences.v1';
const cacheKey = 'hermy.brief.state.v1';
function load(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
let preferences = example ? {} : load(storageKey, {});
if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) preferences = {};
preferences.snoozed ??= {};
let state = null, sensors = null, day = 'today', expandedTasks = false, connected = false;
let spoken = null, lastClock = '', toastTimer, speechTimer, presenceSince=null;
const viewStartedAt=Date.now();
let agentHover=false,agentFocus=false;
const signatures = new Map();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
function reveal(target) {
  if (reducedMotion.matches || document.hidden) return;
  target.getAnimations().forEach(a=>a.cancel());
  target.animate([{opacity:.35,transform:'translateY(5px)'},{opacity:1,transform:'translateY(0)'}],{duration:320,easing:'cubic-bezier(.2,.7,.2,1)'});
}
const labels = { calendar:'Calendar', weather:'Weather', notion:'Reminders', wellness:'Sleep',
  leaveby:'Travel estimates', countdown:'Upcoming dates', spotify:'Music', nanoleaf:'Lights',
  news:'Reading', quote:'Daily quote', astro:'Daylight', aqi:'Air quality' };
function el(tag, cls, text) {
  const n = document.createElement(tag); if (cls) n.className=cls;
  if (text != null) n.textContent=String(text); return n;
}
function replace(id, signature, build) {
  const sig = JSON.stringify(signature);
  if (signatures.get(id) === sig) return;
  signatures.set(id,sig);
  const target=$(id), focusKey=target.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
  const previousContent=target.textContent;
  target.replaceChildren(...build());
  if(previousContent!==target.textContent) reveal(target);
  if (focusKey) [...target.querySelectorAll('[data-focus-key]')].find(n=>n.dataset.focusKey===focusKey)?.focus({preventScroll:true});
}
function button(text, action, cls='text-button') {
  const n=el('button',cls,text); n.type='button';n.addEventListener('click',action);return n;
}
function save() { if (!example) try { localStorage.setItem(storageKey,JSON.stringify(preferences)); } catch {} }
function toast(text) { $('toast').textContent=text;$('toast').hidden=false;reveal($('toast'));clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,3500); }
function weatherGlyph(code) { return code===0?'☀':code<=2?'◐':code<=3?'☁':code<=48?'≋':code>=71&&code<=77?'❄':code>=95?'ϟ':'☂'; }
function quantity(v,suffix='') { return Number.isFinite(v) ? `${Math.round(v)}${suffix}` : '—'; }
function noteFor(name, now) {
  const entry=state?.modules?.[name];
  return `${fresh(entry,name,now)?'':'Update delayed · '}${ageLabel(entry?.fetchedAt,now)}`;
}
function clock(now, zone) {
  const date=new Date(now);
  const text=timeLabel(now,zone);
  if(lastClock===text) return; lastClock=text;
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:zone,hour:'numeric',minute:'2-digit',hour12:true}).formatToParts(date);
  $('time').textContent=parts.filter(p=>['hour','minute','literal'].includes(p.type)).map(p=>p.value).join('').trim();
  $('period').textContent=parts.find(p=>p.type==='dayPeriod')?.value??'';
  $('date').textContent=new Intl.DateTimeFormat('en-US',{timeZone:zone,weekday:'long',month:'long',day:'numeric'}).format(date);
  const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:zone,hour:'numeric',hourCycle:'h23'}).format(date));
  $('greeting').textContent=hour<4?'A quiet night, Maanav.':`Good ${hour<12?'morning':hour<17?'afternoon':'evening'}, Maanav.`;
  document.body.classList.toggle('night',mirror&&(hour>=23||hour<5));
}
function renderWeather(m, now, zone) {
  const entry=m.weather,data=entry?.data,isFresh=fresh(entry,'weather',now);
  replace('weather-body',[data,isFresh,m.astro?.data,Math.floor(now/MINUTE)],()=>{
    if(!data?.current) return [el('p','empty','Weather is unavailable right now.')];
    const summary=el('div','weather-summary');
    const glyph=el('span','weather-icon',weatherGlyph(data.current.code));glyph.setAttribute('aria-hidden','true');
    summary.append(glyph,el('span','temperature',quantity(data.current.temp,'°')));
    const desc=el('div','weather-description');desc.append(el('p','',isFresh?data.current.text:'Last reported'),el('p','',`H ${quantity(data.today?.hi,'°')}  ·  L ${quantity(data.today?.lo,'°')}`));summary.append(desc);
    const out=[summary];
    const comfort=comfortFor(entry,now,zone);if(comfort)out.push(el('p','weather-comfort',comfort));
    if(isFresh){
      const forecast=el('div','forecast');
      for(const h of (data.hours??[]).filter(h=>instant(h.at)+60*MINUTE>now).slice(0,5)) {
        const cell=el('div','forecast-hour');cell.append(el('span','',timeLabel(instant(h.at),zone).replace(':00','')),el('span','symbol',weatherGlyph(h.code)),el('strong','',quantity(h.temp,'°')));forecast.append(cell);
      }
      out.push(forecast);
      const sunlight=sunlightFor(m.astro,now,zone);
      if(sunlight.length){const group=el('div','sun-times');for(const info of sunlight){const row=el('div',`sun-context ${info.kind}`);row.append(el('strong','',info.title));if(info.detail)row.append(el('span','',info.detail));group.append(row);}out.push(group);}
    } else out.push(el('p','source-note',noteFor('weather',now)));
    return out;
  });
}
function renderAttention(model, now) {
  const notices=model.notices.filter(n=>n.type==='event').slice(0,mirror?1:2);
  const brief=briefFor(state,now);
  const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:model.timeZone,hour:'numeric',hourCycle:'h23'}).format(now));
  // A quiet weekend does not need a countdown to its routine workout. An
  // imminent event still earns the attention card, and the night brief stays.
  document.querySelector('.attention').hidden=!notices.length&&!showTimeline(state,now)&&hour>=4&&hour<20;
  $('attention-count').textContent=notices.length?`${notices.length} ${notices.length===1?'NOTICE':'NOTICES'}`:'';
  replace('attention-body',[notices,brief,model.next,model.calendarReady,model.snoozedCount],()=>{
    if(!notices.length) {
      const box=el('div','quiet-state');
      box.append(el('p','notice-label',brief.label),el('h3','',brief.title),el('p','',brief.detail));
      return [box];
    }
    return notices.map(n=>{
      const row=el('article',`notice${n.urgent?' urgent':''}`);
      row.append(el('div','notice-label',n.label),el('h3','',n.title),el('p','',n.detail));
      if(n.note) row.append(el('p','notice-note',n.note));
      const foot=el('div','notice-foot');foot.append(el('span','source-note',n.type==='event'?'Calendar':n.type==='leave'?'Travel estimate':n.type==='rain'?'Weather':'Notion'));
      const snooze=button('Snooze 10 min',()=>{preferences.snoozed[n.id]=Math.min(Date.now()+10*MINUTE,n.expiresAt);save();render();toast('Snoozed on this device.');});
      snooze.dataset.focusKey=`snooze:${n.id}`;snooze.setAttribute('aria-label',`Snooze ${n.title} for 10 minutes`);foot.append(snooze);row.append(foot);return row;
    });
  });
  $('undo-snooze').hidden=!model.snoozedCount;
}
function renderAgenda(m, model, now) {
  const zone=model.timeZone;
  const today=dateKey(now,zone);
  // Noon UTC on the next civil date avoids DST and timezone day-boundary drift.
  const tomorrow=new Date(`${today}T12:00:00Z`);tomorrow.setUTCDate(tomorrow.getUTCDate()+1);
  let target=day==='today'?today:tomorrow.toISOString().slice(0,10);
  let events=agendaFor(m.calendar?.data,target,now,zone);
  if(mirror&&!events.length){target=tomorrow.toISOString().slice(0,10);events=agendaFor(m.calendar?.data,target,now,zone);}
  $('agenda-heading').textContent=mirror?(target===today?'Still to come':'Tomorrow'):'Your day';
  replace('agenda-body',[events,model.calendarReady,target,Math.floor(now/MINUTE)],()=>{
    if(!events.length) {
      const empty=el('div','agenda-empty');empty.append(el('p','empty',model.calendarReady?(target===today?'No more events today.':'Nothing scheduled tomorrow.'):'Calendar not current.'));
      if(!mirror)empty.append(el('p','empty-sub',model.calendarReady?'Check the other day to see what’s next.':'Your saved events will return when available.'));return [empty];
    }
    return events.slice(0,mirror?2:6).map(e=>{
      const isCurrent=!e.allDay&&instant(e.start)<=now&&instant(e.end)>now;
      const row=el('div',`agenda-row${isCurrent&&model.calendarReady?' current':''}`);
      const when=el('div','event-time',e.allDay?'All day':timeLabel(instant(e.start),zone));
      if(isCurrent&&model.calendarReady) when.append(el('span','','NOW'));
      const copy=el('div');copy.append(el('p','event-title',e.title));
      if(e.location)copy.append(el('p','event-location',e.location));row.append(when,copy);return row;
    });
  });
  const extra=Math.max(0,events.length-(mirror?2:6));
  $('calendar-note').textContent=[model.calendarReady?'':`Calendar · ${noteFor('calendar',now)}`,extra?`${extra} more events`:null].filter(Boolean).join(' · ');
  $('calendar-note').hidden=!$('calendar-note').textContent;
}
function renderTasks(m, now) {
  const shown=focusTasks(state,now,mirror?2:4);
  $('tasks-count').textContent='';
  replace('tasks-body',[shown],()=>shown.length?shown.map(t=>{
    const row=el('div','task-row');
    const copy=el('div','task-copy');
    copy.append(el('p','task-meta',`${t.source==='work'?'WORK':'PERSONAL'} · ${t.reason}`),el('p','task-title',t.title));
    row.append(copy);return row;
  }):[el('p','empty','Nothing to pull forward right now.')]);
  $('more-tasks').hidden=true;
  const unavailable=['notion','workboard'].filter(k=>!fresh(m[k],k,now)||m[k]?.data?.configured===false);
  $('tasks-note').textContent=unavailable.length?`${unavailable.map(k=>k==='notion'?'Personal tasks':'Command Board').join(' · ')} unavailable`:'';
  $('tasks-note').hidden=!unavailable.length;
}
function renderHorizon(m, now) {
  const data=horizonFor(m.countdown,now,m.calendar?.data?.timeZone??'America/Los_Angeles');
  replace('horizon-body',data,()=>{
    if(!data?.items?.length)return [el('p','empty','No upcoming dates to count down to.')];
    return data.items.slice(0,2).map(i=>{const row=el('div','horizon-row'),copy=el('div','horizon-copy');const title=String(i.label).toLowerCase().replace(/\b\w/g,c=>c.toUpperCase()).replace(/\bSf\b/g,'SF');copy.append(el('p','',i.kind==='flight'?'NEXT TRIP':'COMING UP'),el('h3','',title));const count=el('div','horizon-days',i.days===0?'Today':i.days);if(i.days!==0)count.append(el('span','',i.days===1?'day':'days'));row.append(copy,count);return row;});
  });
}
function renderDetails(m,now) {
  if($('details-panel').hidden)return;
  replace('details-panel',[m,sensors,Math.floor(now/MINUTE)],()=>{
    const blocks=[];
    const block=(title,lines,note)=>{const b=el('div','detail-block');b.append(el('h3','',title),...lines.map(v=>el('p','',v)));if(note)b.append(el('p','source-note',note));blocks.push(b);return b;};
    const wellness=fresh(m.wellness,'wellness',now)?m.wellness.data:null;
    block('Sleep',wellness?[`Sleep score ${wellness.score??'—'}`,`HRV ${wellness.hrv??'—'}`]:['No recent sleep reading.'],noteFor('wellness',now));
    const music=fresh(m.spotify,'spotify',now)?m.spotify.data:null;
    block('Listening',music?.isPlaying&&music.track?[music.track.name,(music.track.artists??[]).join(', ')]:['Nothing playing right now.']);
    const lights=fresh(m.nanoleaf,'nanoleaf',now)?m.nanoleaf.data?.lights:[];
    block('At home',(lights?.length?lights.map(l=>`${l.name??l.label??'Light'} · ${l.on?'on':'off'}`):['No recent lighting update.']));
    const q=m.quote?.data;if(q?.text)block('A thought for today',[q.text,`— ${q.author}`],q.credit??'');
    const headlines=fresh(m.news,'news',now)?m.news.data:[];
    if(headlines?.length)block('For later',headlines.slice(0,2).map(h=>h.title),'Hacker News');
    block('Your connections',Object.keys(labels).filter(k=>m[k]).map(k=>`${labels[k]} · ${fresh(m[k],k,now)?'up to date':'update delayed'}`));
    return blocks;
  });
}
function renderLighting(m,now) {
  const lights=lightingFor(m.nanoleaf,now);
  const lingerSince=example?viewStartedAt:presenceSince;
  $('room-lights').classList.toggle('expanded',lingerSince!=null&&Date.now()-lingerSince>=8000);
  replace('room-lights',lights,()=>lights.map(light=>{
    const row=el('span',`room-light ${light.status}`);
    const dot=el('span','light-dot');dot.setAttribute('aria-hidden','true');
    row.append(dot,el('span','light-name',light.name),el('span','light-state',light.status==='unknown'?'No signal':light.status==='on'?'On':'Off'));
    if(light.percent!=null)row.append(el('span','light-level',`${light.percent}%`));
    return row;
  }));
}
function renderTimeline(now) {
  document.querySelector('.day-timeline').hidden=!showTimeline(state,now);
  if(!showTimeline(state,now))return;
  const t=timelineFor(state,now),length=t.end-t.start;
  $('timeline-source').textContent=t.source;
  replace('timeline-body',[t.start,t.end,t.busy,t.calendarReady,Math.floor(now/MINUTE)],()=>{
    const ends=el('div','timeline-ends');ends.append(el('span','',`${t.wakeLabel} ${timeLabel(t.start,t.zone)}`),el('span','',`${t.sleepLabel} ${timeLabel(t.end,t.zone)}`));
    const bar=el('div','timeline-track');bar.setAttribute('role','img');bar.setAttribute('aria-label',t.calendarReady?`${t.busy.length} scheduled blocks between ${timeLabel(t.start,t.zone)} and ${timeLabel(t.end,t.zone)}`:'Calendar unavailable; gaps cannot be determined');
    for(const b of t.busy){const segment=el('span','timeline-busy');segment.style.left=`${(b.start-t.start)/length*100}%`;segment.style.width=`${(b.end-b.start)/length*100}%`;segment.title=`${b.titles.join(' · ')} · ${timeLabel(b.start,t.zone)}–${timeLabel(b.end,t.zone)}`;bar.append(segment);}
    if(now>=t.start&&now<=t.end){const marker=el('span','timeline-now');marker.style.left=`${t.nowFraction*100}%`;bar.append(marker);}
    const note=el('p','timeline-gap');
    if(!t.calendarReady)note.textContent='Calendar unavailable · gaps not shown';
    else if(t.nextGap){const g=t.nextGap,minutes=Math.floor((g.end-g.start)/MINUTE);note.textContent=`${g.start<=now?'Open now':'Next gap at '+timeLabel(g.start,t.zone)} · ${minutes>=60?Math.floor(minutes/60)+'h ':''}${minutes%60?minutes%60+'m':''} until ${timeLabel(g.end,t.zone)}`;}
    else note.textContent=now>t.end?'Your waking day is winding down.':'No open block of 15 minutes or more.';
    const scale=el('div','timeline-scale');
    for(let hour=0;hour<=48;hour+=3){
      const at=localInstant(dateKey(t.start,t.zone),hour,t.zone);
      if(at<=t.start+30*MINUTE||at>=t.end-30*MINUTE)continue;
      const tick=el('span','',timeLabel(at,t.zone).replace(':00',''));
      tick.style.left=`${(at-t.start)/length*100}%`;scale.append(tick);
    }
    return [ends,bar,scale,note];
  });
}
function renderAgents(m,now) {
  const data=fresh(m.agents,'agents',now)?m.agents.data:null;
  const unavailable=Boolean(m.agents&&(!fresh(m.agents,'agents',now)||data?.connected===false));
  const items=(data?.items??[]).filter(a=>(a.live===true && (example||Number.isFinite(a.lastActivityAt)&&now/1000-a.lastActivityAt<=180) && ['running','working','thinking','tool'].includes(a.status))||a.status==='waiting');
  const lingerSince=example?viewStartedAt:presenceSince;
  const expanded=agentHover||agentFocus||(lingerSince!=null&&Date.now()-lingerSince>=8000);
  const page=expanded?Math.floor((Date.now()-(lingerSince??viewStartedAt))/18000)%Math.max(1,Math.ceil(items.length/6)):0;
  document.querySelector('.agent-station').hidden=!items.length&&!unavailable;
  document.body.classList.toggle('agents-expanded',expanded);
  const liveCount=items.filter(a=>a.live).length;
  $('agent-count').textContent=unavailable?'UPDATES PAUSED':liveCount?`${liveCount} LIVE`:items.length?'WAITING':'';
  replace('agents-body',[items,data?.connected,page,unavailable],()=>{
    if(unavailable)return [el('p','agent-empty','Reconnecting to Hermes…')];
    if(!items.length)return [el('p','agent-empty','No agents running right now.')];
    const out=[];
    for(const a of items.slice(page*6,page*6+6)){
      const row=el('div',`agent-row${a.live?'':' waiting'}`);
      const color=String(a.id).split('').reduce((n,c)=>(n*31+c.charCodeAt(0))%6,0);
      const hue=[0,45,90,150,220,285][color];
      const sprite=el('span','agent-sprite');sprite.setAttribute('aria-hidden','true');sprite.style.setProperty('--agent-hue',`${hue}deg`);
      const name=a.source?.startsWith('hermes-')?'Hermes':a.name??'Agent';
      const copy=el('div','agent-copy');copy.append(el('p','agent-name',`${name}${a.status==='waiting'?' · waiting':''}`),el('p','agent-task',a.task??'Working'));
      row.append(sprite,copy);out.push(row);
    }
    if(items.length>6)out.push(el('p','agent-page',`${page*6+1}–${Math.min(items.length,page*6+6)} / ${items.length}`));
    return out;
  });
}
const agentStation=document.querySelector('.agent-station');
agentStation.addEventListener('pointerenter',()=>{agentHover=true;render();});
agentStation.addEventListener('pointerleave',()=>{agentHover=false;render();});
agentStation.addEventListener('focusin',()=>{agentFocus=true;render();});
agentStation.addEventListener('focusout',()=>{agentFocus=false;render();});
function renderProgress(m,now) {
  const d=fresh(m.progress,'progress',now)?m.progress.data:null;
  replace('progress-body',d,()=>{
    if(!d)return [el('p','empty','Progress tracking is connecting.')];
    if(!d.trackingSince)return [el('p','empty','Waiting for a complete task snapshot.')];
    const count=el('p','progress-count');count.append(el('strong','',d.weekCount??0),document.createTextNode(' completed'));
    const out=[count];
    if(d.trackingSince)out.push(el('p','source-note',`Observed since ${new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',timeZone:d.timeZone}).format(new Date(d.trackingSince))}`));
    const completed=(d.items??[]).slice(0,2);
    for(const item of completed)out.push(el('p','progress-item',`✓ ${item.title}`));
    if(d.coverage?.complete===false)out.push(el('p','source-note','Some task updates are delayed.'));
    return out;
  });
}
function renderMusic(m,now) {
  const d=fresh(m.spotify,'spotify',now)?m.spotify.data:null;
  const playing=d?.isPlaying===true&&d.track;
  document.querySelector('.now-playing').hidden=!playing;
  if(!playing)return;
  replace('music-body',[d.track,d.progressMs],()=>{
    const out=[];
    if(d.track.albumArtUrl){const art=el('img','album-art');art.src=d.track.albumArtUrl;art.alt='';out.push(art);}
    const copy=el('div','music-copy');copy.append(el('p','eyebrow','NOW PLAYING'),el('p','music-title',d.track.name),el('p','music-artist',(d.track.artists??[]).join(' · ')));
    const line=el('div','music-progress'),fill=el('span');fill.style.width=`${Math.min(100,Math.max(0,d.progressMs/Math.max(1,d.durationMs)*100))}%`;line.append(fill);copy.append(line);out.push(copy);return out;
  });
}
function render() {
  const now=example&&state?.exampleNow?state.exampleNow:Date.now(),m=state?.modules??{},model=buildAttention({...state,modules:{...m,leaveby:null}},{now,snoozed:preferences.snoozed});
  clock(now,model.timeZone);
  renderLighting(m,now);
  document.body.classList.toggle('soft-off',mirror&&!preview&&!example&&state?.display?.on===false);
  $('day-note').textContent=model.current?'A little focus, right here.':model.next?`Next on your calendar at ${timeLabel(instant(model.next.start),model.timeZone)}.`:'A little room to think.';
  renderTimeline(now);renderAgents(m,now);renderProgress(m,now);renderMusic(m,now);renderWeather(m,now,model.timeZone);renderAttention(model,now);renderAgenda(m,model,now);renderTasks(m,now);renderHorizon(m,now);renderDetails(m,now);
  document.querySelector('.hermy-note').classList.toggle('speaking',spoken?.until>Date.now()||example==='talking');
  const quote=fresh(m.quote,'quote',now)?m.quote.data:null;
  $('hermy-note').textContent=spoken?.until>Date.now()?spoken.text:example==='talking'?'Let’s take it one thing at a time.':quote?.text??'You don’t have to do it all at once. Give the next small thing your attention.';
  $('quote-author').textContent=spoken?.until>Date.now()?'':quote?.author?`— ${quote.author}`:'';

}
$('today-tab').addEventListener('click',()=>setDay('today'));
$('tomorrow-tab').addEventListener('click',()=>setDay('tomorrow'));
function setDay(value){day=value;$('today-tab').setAttribute('aria-pressed',String(day==='today'));$('tomorrow-tab').setAttribute('aria-pressed',String(day==='tomorrow'));render();}
$('more-tasks').addEventListener('click',()=>{expandedTasks=!expandedTasks;render();});
$('undo-snooze').addEventListener('click',()=>{preferences.snoozed={};save();render();});
$('details-toggle').addEventListener('click',()=>{const open=$('details-panel').hidden;$('details-panel').hidden=!open;$('details-toggle').setAttribute('aria-expanded',String(open));$('details-toggle').replaceChildren(document.createTextNode('Around you '),el('span','',open?'−':'＋'));render();if(open)reveal($('details-panel'));});
function accept(next){if(!next?.modules)return;state=next;connected=true;if(!example)try{localStorage.setItem(cacheKey,JSON.stringify(next));}catch{}render();}
let cameraObjectUrl=null;
async function cameraLoop(){
  let delay=80;
  try {
    if(document.hidden){delay=1000;return;}
    const response=await fetch('/api/camera/frame.jpg',{cache:'no-store',signal:AbortSignal.timeout(4500)});
    if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||'Camera unavailable');}
    const nextUrl=URL.createObjectURL(await response.blob()),image=$('camera-image');
    const previous=cameraObjectUrl;
    image.src=nextUrl;cameraObjectUrl=nextUrl;
    try {await image.decode();}finally{if(previous)URL.revokeObjectURL(previous);}
    image.hidden=false;$('camera-message').hidden=true;
    $('camera-status').textContent='LIVE';$('camera-status').classList.add('live');
  } catch(error) {
    delay=3000;$('camera-image').hidden=true;$('camera-message').hidden=false;
    $('camera-message').textContent=error.name==='TimeoutError'?'Camera connection lost':error.message;
    $('camera-status').textContent='OFFLINE';$('camera-status').classList.remove('live');
    if(cameraObjectUrl){URL.revokeObjectURL(cameraObjectUrl);cameraObjectUrl=null;}
  } finally {setTimeout(cameraLoop,delay);}
}
$('camera-flip').addEventListener('click',()=>{const flipped=$('camera-image').classList.toggle('flipped');$('camera-flip').setAttribute('aria-pressed',String(flipped));});
if(example)document.querySelector('.camera-view').hidden=true;else cameraLoop();
let polling=false;
async function poll(){if(polling)return;polling=true;try{const r=await fetch('/api/state?view=dashboard',{cache:'no-store',signal:AbortSignal.timeout(8000)});if(!r.ok)throw new Error('unavailable');accept(await r.json());}catch{connected=false;render();}finally{polling=false;}}
if(example){
  $('example-bar').hidden=false;
  const {exampleState}=await import('./dashboard-examples.js?v=9');
  accept(exampleState(example,Date.now()));
}else{
  const {startLiveUpdates}=await import('./live-updates.js');
  startLiveUpdates();
  state=load(cacheKey,null);render();poll();
  const stream=new EventSource('/api/events?view=dashboard');
  stream.addEventListener('state',e=>{try{accept(JSON.parse(e.data));}catch{}});
  stream.addEventListener('open',()=>{connected=true;render();});
  stream.addEventListener('error',()=>{connected=false;render();});
  stream.addEventListener('say',e=>{try{const d=JSON.parse(e.data);spoken={text:String(d.text??'').slice(0,220),until:Date.now()+Math.min(Number(d.holdMs)||20000,60000)};clearTimeout(speechTimer);speechTimer=setTimeout(()=>{spoken=null;render();},Math.max(0,spoken.until-Date.now()));render();}catch{}});
  stream.addEventListener('sensors',e=>{try{sensors=JSON.parse(e.data);if(sensors.present===true){presenceSince??=Date.now();}else presenceSince=null;}catch{}});
  // Faster than the agent feed's 30-second freshness window, even without SSE.
  setInterval(poll,15000);
}
setInterval(render,5000);
if(mirror&&!matchMedia('(prefers-reduced-motion: reduce)').matches)setInterval(()=>{$('dashboard').style.transform=`translate(${Math.round(Math.random()*6-3)}px,${Math.round(Math.random()*6-3)}px)`;},10*MINUTE);
