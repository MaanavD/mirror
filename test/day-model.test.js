import test from 'node:test';
import assert from 'node:assert/strict';
import {lightingFor,localInstant,wakingWindow,timelineFor,prioritiesFor,comfortFor,briefFor,focusTasks,showTimeline,isWorkoutEvent} from '../public/day-model.js';
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
test('timeline merges overlap, clips waking window, ignores free and all-day events',()=>{
 const t=timelineFor(state([event('early',7,9),event('a',10,12),event('b',11,13),event('free',14,16,{busy:false}),event('day',8,23,{allDay:true})]),now);
 assert.deepEqual(t.busy.map(b=>[b.start,b.end]),[[Date.parse(at(8)),Date.parse(at(9))],[Date.parse(at(10)),Date.parse(at(13))]]);
 assert.equal(t.nextGap.start,Date.parse(at(13)));assert.equal(t.nextGap.end,Date.parse(at(23)));
});
test('partial or stale calendar never claims free time',()=>{
 for(const stale of [true,false]){const s=state([]);s.modules.calendar.stale=stale;s.modules.calendar.data.coverageComplete=stale;
 assert.equal(timelineFor(s,now).nextGap,null);assert.deepEqual(timelineFor(s,now).gaps,[]);}
});
test('actual wake survives absent bedtime, with explicit estimate',()=>{
 const w=wakingWindow(entry({dayWindow:{wakeAt:at(9),bedtimeAt:null,wakeSource:'eight_sleep'}}),now,zone);
 assert.equal(w.start,Date.parse(at(9)));assert.equal(w.end,Date.parse(at(24)));assert.equal(w.estimated,true);assert.match(w.source,/sleep estimated/);
});
test('the 23:30 wellness target replaces the midnight fallback when no bedtime was measured',()=>{
 const w=wakingWindow(entry({dayWindow:{wakeAt:at(9),bedtimeAt:null,wakeSource:'eight_sleep',sleepTargetMinutes:1410,sleepTargetClock:'11:30P'}}),now,zone);
 assert.equal(w.start,Date.parse(at(9)));
 assert.equal(w.end,new Date(localInstant('2026-09-06',23,zone,30)).getTime());
 assert.equal(w.sleepLabel,'Bed target');
 assert.match(w.source,/bed target 11:30P/);
 assert.equal(w.estimated,true);
 // A measured bedtime still wins over the target.
 const measured=wakingWindow(entry({dayWindow:{wakeAt:at(9),bedtimeAt:at(22),bedtimeSource:'eight_sleep',wakeSource:'eight_sleep',sleepTargetMinutes:1410}}),now,zone);
 assert.equal(measured.end,Date.parse(at(22)));assert.equal(measured.sleepLabel,'Bedtime');
});
test('an estimated day also ends at the target instead of midnight',()=>{
 // No usable wake, but the wellness reading itself is current.
 const e=entry({dayWindow:{wakeAt:null,sleepTargetMinutes:1410,sleepTargetClock:'11:30P'}});
 const w=wakingWindow(e,now,zone);
 assert.equal(w.start,Date.parse(at(9)));
 assert.equal(w.end,new Date(localInstant('2026-09-06',23,zone,30)).getTime());
 assert.equal(w.sleepLabel,'Bed target');
 // A target that would land before the wake is ignored, not inverted.
 const early=entry({dayWindow:{wakeAt:at(9),bedtimeAt:null,wakeSource:'eight_sleep',sleepTargetMinutes:8*60}});
 assert.equal(wakingWindow(early,now,zone).end,Date.parse(at(24)));
});
test('overnight fallback uses previous day and discards stale wake',()=>{
 const e=entry({dayWindow:{wakeAt:at(9),bedtimeAt:at(23)}});e.stale=true;
 const w=wakingWindow(e,Date.parse('2026-09-07T09:00:00Z'),zone);
 assert.equal(w.start,Date.parse(at(9)));assert.equal(w.end,Date.parse(at(24)));
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
test('brief picks effort that fits the gap with a buffer',()=>{
 const s=state([event('Meeting',12,13)]);s.modules.workboard=entry({items:[{id:'long',title:'Long task',status:'Review',effortMinutes:60},{id:'short',title:'Quick review',status:'Active',effortMinutes:15}]});
 const b=briefFor(s,now);assert.match(b.title,/1h before/);assert.equal(b.detail,'15 min · Quick review');
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

test('night brief makes a tomorrow event explicit',()=>{
 const late=Date.parse('2026-09-06T09:00:00Z'),s=state([{id:'tomorrow',title:'Planning',start:'2026-09-07T16:00:00Z',end:'2026-09-07T17:00:00Z'}]);
 s.modules.calendar.fetchedAt=late;assert.equal(briefFor(s,late).label,'Tomorrow');
});

test('focus balances sources only when priorities are close',()=>{
 const s=state([]);s.modules.notion=entry({items:[{id:'a',title:'A',due:'2026-09-06'},{id:'b',title:'B',due:'2026-09-06'}]});s.modules.workboard=entry({items:[{id:'c',title:'C',status:'Review'}]});
 assert.deepEqual(focusTasks(s,now).map(t=>t.id),['a','c']);
 s.modules.workboard.data.items[0].status='Inbox';assert.deepEqual(focusTasks(s,now).map(t=>t.id),['a','b']);
});

test('weekend timeline stays hidden for workout-only and empty calendars',()=>{
 assert.equal(showTimeline(state([]),now),false);
 assert.equal(showTimeline(state([event('Workout: Recovery Mobility',14,15)]),now),false);
 assert.equal(showTimeline(state([event('Dinner',18,19)]),now),true);
});
test('weekdays keep the timeline even without events',()=>{
 const monday=Date.parse('2026-09-07T18:00:00Z');assert.equal(showTimeline(state([]),monday),true);
});
test('weekend visibility uses local dates and fresh events only',()=>{
 const s=state([event('Meeting',14,15)]);s.modules.calendar.stale=true;assert.equal(showTimeline(s,now),false);
 const saturdayUTC=Date.parse('2026-09-05T02:00:00Z');assert.equal(showTimeline(state([]),saturdayUTC),true);
 const tomorrow=state([{id:'tomorrow',title:'Meeting',start:'2026-09-07T16:00:00Z',end:'2026-09-07T17:00:00Z'}]);assert.equal(showTimeline(tomorrow,now),false);
});
test('workout classifier does not confuse ordinary work with exercise',()=>{
 for(const title of ['Workout: Recovery Mobility','lift — pull','Morning run','Yoga class'])assert.equal(isWorkoutEvent({title}),true,title);
 for(const title of ['Run through the demo','Product Planning','Working session'])assert.equal(isWorkoutEvent({title}),false,title);
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
