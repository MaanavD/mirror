import test from 'node:test';
import assert from 'node:assert/strict';
import {lightingFor,localInstant,prioritiesFor,comfortFor,focusTasks,firstMeetingTomorrow,cutoffsFor,streamFor,headlineFor,lastNightFor} from '../public/day-model.js';
import {sleepSchedule} from '../public/sleep-model.js';
import {taskRecords,pickProperties} from '../src/modules/notion.js';
import {shapeAgenda} from '../src/modules/calendar.js';
const zone='America/Los_Angeles',now=Date.parse('2026-09-06T18:00:00Z');
const entry=data=>({data,stale:false,fetchedAt:now});
const at=hour=>new Date(localInstant('2026-09-06',hour,zone)).toISOString();
const event=(id,start,end,extra={})=>({id,title:id,start:at(start),end:at(end),...extra});
const state=events=>({modules:{calendar:entry({configured:true,timeZone:zone,events}),wellness:entry({dayWindow:{wakeAt:at(8),bedtimeAt:at(23),wakeSource:'eight_sleep',bedtimeSource:'estimated',estimated:true}})}});
test('civil conversion follows DST and midnight rollover',()=>{
 assert.equal(new Date(localInstant('2026-03-08',8,zone)).toISOString(),'2026-03-08T15:00:00.000Z');
 assert.equal(new Date(localInstant('2026-11-01',8,zone)).toISOString(),'2026-11-01T16:00:00.000Z');
 assert.equal(new Date(localInstant('2026-09-06',24,zone)).toISOString(),'2026-09-07T07:00:00.000Z');
});


test('first meeting tomorrow skips a dance practice',()=>{
 const meeting={id:'meeting',title:'Standup',allDay:false,start:new Date(localInstant('2026-09-07',9,zone)).toISOString(),end:new Date(localInstant('2026-09-07',10,zone)).toISOString(),busy:true};
 const dance={id:'dance',title:'Raj Dance practice',allDay:false,start:new Date(localInstant('2026-09-07',8,zone)).toISOString(),end:new Date(localInstant('2026-09-07',9,zone)).toISOString(),busy:true};
 assert.equal(firstMeetingTomorrow(entry({configured:true,timeZone:zone,events:[dance,meeting]}),now,zone).title,'Standup');
});

test('cutoffs count back from bed; caffeine is a window',()=>{
 const bed=localInstant('2026-09-07',0,zone,30);
 const {cutoffs,next}=cutoffsFor(bed,localInstant('2026-09-06',13,zone,30));
 assert.deepEqual(cutoffs.map(c=>[c.id,c.at]),[
  ['caffeine',localInstant('2026-09-06',12,zone,30)],['exercise',localInstant('2026-09-06',20,zone,30)],
  ['food',localInstant('2026-09-06',20,zone,30)],['blue-light',localInstant('2026-09-06',22,zone,30)],
  ['screens',localInstant('2026-09-06',23,zone,30)]]);
 assert.equal(cutoffs[0].atEnd,localInstant('2026-09-06',14,zone,30));
 assert.equal(next.id,'caffeine','inside the window it is still the live cutoff');
 assert.equal(cutoffsFor(bed,localInstant('2026-09-06',21,zone,15)).next.id,'blue-light');
});

// Fixtures are stamped as just fetched at whatever instant a test asks about.
const at_=(s,t)=>{for(const e of Object.values(s.modules))if(!e.stale)e.fetchedAt=t;return s;};
const sched=(s,t)=>sleepSchedule({now:t,zone,calendar:at_(s,t).modules.calendar,wellness:s.modules.wellness});

test('stream: one chronological list with gaps, the next cutoff and bed',()=>{
 const s=state([event('a',10,12),event('b',11,13),event('free',15,16,{busy:false}),event('dinner',19,20),event('day',8,23,{allDay:true})]);
 const t=localInstant('2026-09-06',11,zone,30),st=streamFor(s,t,sched(s,t));
 assert.deepEqual(st.rows.map(r=>r.kind+(r.id?':'+r.id:'')),['event:a','event:b','cutoff:caffeine','gap','event:dinner','gap','bed']);
 assert.equal(st.rows[0].now,true);
 assert.deepEqual(st.allDay,['day']);
});

test('stream: a stale calendar never claims free time',()=>{
 const s=state([event('a',14,15)]);s.modules.calendar.stale=true;
 const st=streamFor(s,now,sched(s,now));
 assert.equal(st.calendarReady,false);
 assert.deepEqual(st.rows.filter(r=>r.kind==='gap'||r.kind==='event'),[]);
});

test('stream: nothing left today brings tomorrow forward',()=>{
 const s=state([{id:'t',title:'Planning',allDay:false,start:new Date(localInstant('2026-09-07',10,zone)).toISOString(),end:new Date(localInstant('2026-09-07',11,zone)).toISOString()}]);
 const st=streamFor(s,now,sched(s,now));
 assert.equal(st.tomorrow[0].title,'Planning');
});

test('headline: soon beats now; now names what follows; next otherwise',()=>{
 const s=state([event('current',10,12),event('review',12,13)]);
 const at1150=localInstant('2026-09-06',11,zone,50),sc=sched(s,at1150);
 assert.equal(headlineFor(s,at1150,sc).tone,'soon');
 const at11=localInstant('2026-09-06',11,zone);
 const h=headlineFor(s,at11,sched(s,at11));
 assert.equal(h.tone,'now');assert.equal(h.eventId,'current');assert.match(h.detail,/then 12:00 PM review/);
 const at9=localInstant('2026-09-06',9,zone);
 assert.equal(headlineFor(s,at9,{...sched(s,at9),phase:'day'}).title,'current');
});

test('headline: wind-down, bedtime and morning speak about sleep',()=>{
 const s=state([]);
 const wind=localInstant('2026-09-06',23,zone);
 assert.match(headlineFor(s,wind,sched(s,wind)).title,/^Bed at 12:30 AM · in 1h 30m$/);
 const late=localInstant('2026-09-07',0,zone,45);
 assert.equal(headlineFor(s,late,sched(s,late)).title,'Sleep now: 7h 45m');
 const morning=localInstant('2026-09-06',9,zone);
 s.modules.wellness=entry({dayWindow:{lastNight:{wakeAt:at(8),durationHours:7.5,score:88}}});
 const sc=sched(s,morning);
 const h=headlineFor(s,morning,sc);
 assert.equal(h.label,'Good morning');
 assert.equal(lastNightFor(s,morning).asleep,'7h 30m');
});

test('priorities exclude agent work, respect local dates and review status',()=>{
 const s=state([]);s.modules.workboard=entry({items:[{id:'agent',title:'Agent',status:'Agent working',due:'2026-09-06'},{id:'blocked',title:'Blocked',status:'Blocked'},{id:'review',title:'Review',status:'Review',due:'2026-09-05'},{id:'done',title:'Done',status:'Done'}]});
 s.modules.notion=entry({items:[{id:'due',title:'Due',due:'2026-09-07T01:00:00Z'},{id:'old',title:'Old',due:'2026-08-01'}]});
 const tasks=prioritiesFor(s,now);assert.deepEqual(tasks.map(t=>t.id),['due','review','old']);assert.equal(tasks[0].reason,'Due today');assert.equal(tasks[1].reason,'Ready for your review');
});

test('comfort handles snow, invalid dates and stale data',()=>{
 assert.equal(comfortFor(entry({current:{temp:2},hours:[{at:'bad',code:61},{at:at(12),code:73}]}),now,zone),'Snow around 12:00 PM');
 const e=entry({current:{temp:10},hours:[{at:at(12),temp:16,code:1}]});assert.equal(comfortFor(e,now,zone),'Warming to 16° later');e.stale=true;assert.equal(comfortFor(e,now,zone),null);
});

test('personal records retain true status, due date and done rows',()=>{
 const props=pickProperties({properties:{Task:{type:'title'},Status:{type:'status'},Due:{type:'date'}}});
 const row=(id,status)=>({id,properties:{Task:{title:[{plain_text:id}]},Status:{status:{name:status}},Due:{date:{start:'2026-09-06'}}}});
 const records=taskRecords([row('open','In progress'),row('done','Done'),{...row('deleted','Done'),in_trash:true}],props);
 assert.equal(records.length,2);assert.equal(records[0].status,'In progress');assert.equal(records[1].done,true);assert.equal(records[0].due,'2026-09-06');
});

test('calendar retains previous day and transparency for overnight timeline',()=>{
 const result=shapeAgenda([{id:'free',summary:'Free reminder',transparency:'transparent',start:{dateTime:'2026-09-05T15:00:00-07:00'},end:{dateTime:'2026-09-05T16:00:00-07:00'}}],{now:new Date('2026-09-06T02:00:00-07:00'),timeZone:zone});
 assert.equal(result.events.length,1);assert.equal(result.events[0].busy,false);assert.equal(result.today.length,0);
});

test('focus balances sources only when priorities are close',()=>{
 const s=state([]);s.modules.notion=entry({items:[{id:'a',title:'A',due:'2026-09-06'},{id:'b',title:'B',due:'2026-09-06'}]});s.modules.workboard=entry({items:[{id:'c',title:'C',status:'Review'}]});
 assert.deepEqual(focusTasks(s,now).map(t=>t.id),['a','c']);
 s.modules.workboard.data.items[0].status='Inbox';assert.deepEqual(focusTasks(s,now).map(t=>t.id),['a','b']);
});

test('lighting row always includes both lamps and distinguishes off from unavailable',()=>{
 const data={lights:[{entityId:'light.shapes_dedf',name:'Bedstagons',on:true,brightness:128}]};
 const lights=lightingFor(entry(data),now);
 assert.deepEqual(lights.map(l=>[l.name,l.status,l.percent]),[['Flower','unknown',null],['Bedstagons','on',50]]);
 assert.deepEqual(lightingFor(null,now).map(l=>l.status),['unknown','unknown']);
 assert.deepEqual(lightingFor({...entry(data),stale:true},now).map(l=>l.status),['unknown','unknown']);
 assert.deepEqual(lightingFor(entry(data),now+61000).map(l=>l.status),['unknown','unknown']);
 const off=lightingFor(entry({lights:[{entityId:'light.shapes_dedf',on:false,brightness:128}]}),now)[1];
 assert.equal(off.status,'off');assert.equal(off.percent,null);
});
