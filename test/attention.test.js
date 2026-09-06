import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAttention,fresh,agendaFor,tasksFor,horizonFor,MINUTE} from '../public/attention.js';
import {shapeAgenda} from '../src/modules/calendar.js';
import {pickProperties,toTodos} from '../src/modules/notion.js';
import {leavebyModule,resetCache} from '../src/modules/leaveby.js';

const now=Date.parse('2026-09-05T21:00:00Z'),zone='America/Los_Angeles';
const entry=data=>({data,fetchedAt:now,stale:false});
const event=(id,start,end)=>({id,title:id,allDay:false,start:new Date(now+start*MINUTE).toISOString(),end:new Date(now+end*MINUTE).toISOString()});
const state=(events=[])=>({modules:{calendar:entry({configured:true,timeZone:zone,today:events,tomorrow:[]})}});

test('an imminent event becomes current then expires without a server refresh',()=>{
 const s=state([event('review',5,15)]);
 assert.equal(buildAttention(s,{now}).notices[0].label,'Starts in 5 min');
 assert.equal(buildAttention(s,{now:now+5*MINUTE}).notices[0].label,'Happening now');
 assert.equal(buildAttention(s,{now:now+15*MINUTE}).notices.length,0);
});
test('upcoming event in ten minutes takes precedence over a current event',()=>{
 const s=state([event('current',-20,30),event('next',5,40)]);
 assert.equal(buildAttention(s,{now}).notices[0].title,'next');
 assert.equal(buildAttention(s,{now}).notices[0].urgent,true);
});
test('outside the notification window, event remains next but is not a notice',()=>{
 const m=buildAttention(state([event('later',31,60)]),{now});
 assert.equal(m.notices.length,0);assert.equal(m.next.title,'later');
});
test('stale cached calendar is not presented as a current notification',()=>{
 const s=state([event('review',5,30)]);s.modules.calendar.fetchedAt=now-21*MINUTE;
 assert.equal(buildAttention(s,{now}).notices.length,0);assert.equal(buildAttention(s,{now}).calendarReady,false);
});
test('missing timestamps and explicit stale flags are not fresh',()=>{
 assert.equal(fresh({data:{},stale:false},'calendar',now),false);
 assert.equal(fresh({fetchedAt:now,stale:true},'calendar',now),false);
 assert.equal(fresh({fetchedAt:now+3*MINUTE},'calendar',now),false);
});
test('snooze suppresses only its notice and reappears when its timer expires',()=>{
 const s=state([event('review',5,18)]),id=buildAttention(s,{now}).notices[0].id;
 assert.equal(buildAttention(s,{now,snoozed:{[id]:now+10*MINUTE}}).notices.length,0);
 assert.equal(buildAttention(s,{now:now+10*MINUTE,snoozed:{[id]:now+10*MINUTE}}).notices.length,1);
});
test('departure takes precedence and deduplicates the matching event notice',()=>{
 const s=state([event('Dinner',8,60)]);s.modules.leaveby=entry({eventTitle:'Dinner',leaveByMs:now,driveMin:22});
 const notices=buildAttention(s,{now}).notices;assert.equal(notices.length,1);assert.equal(notices[0].label,'Time to leave');
});
test('departure cannot linger after the event or after its ten minute grace',()=>{
 const s=state([event('Dinner',30,60)]);s.modules.leaveby=entry({eventTitle:'Dinner',leaveByMs:now-11*MINUTE,driveMin:22});
 assert.ok(!buildAttention(s,{now}).notices.some(n=>n.type==='leave'));
 s.modules.leaveby.data.leaveByMs=now;s.modules.calendar.data.today=[];
 assert.ok(!buildAttention(s,{now}).notices.some(n=>n.type==='leave'));
});
test('rain becomes irrelevant after its forecast slot and stale weather stays quiet',()=>{
 const s=state();s.modules.weather=entry({rain:{rainAtISO:new Date(now+5*MINUTE).toISOString()}});
 assert.equal(buildAttention(s,{now}).notices[0].type,'rain');
 assert.equal(buildAttention(s,{now:now+21*MINUTE}).notices.length,0);
 s.modules.weather.stale=true;assert.equal(buildAttention(s,{now}).notices.length,0);
});
test('all-day calendar entries do not emit a timed-event alert',()=>{
 const e={...event('holiday',0,60),allDay:true};assert.equal(buildAttention(state([e]),{now}).notices.length,0);
});
test('agenda re-buckets dates after midnight and retains an ongoing overnight event',()=>{
 const e={id:'overnight',title:'Overnight',start:'2026-09-05T06:30:00Z',end:'2026-09-05T08:30:00Z'};
 assert.equal(agendaFor({events:[e]},'2026-09-04',Date.parse('2026-09-05T07:00:00Z'),zone).length,1);
 assert.equal(agendaFor({events:[e]},'2026-09-05',Date.parse('2026-09-05T07:00:00Z'),zone).length,1);
});
test('calendar shaping keeps a late appointment after six ended events',()=>{
 const rows=Array.from({length:6},(_,i)=>event(`past-${i}`,-400+i*40,-380+i*40)).concat(event('next',10,40));
 const shaped=shapeAgenda(rows.map(e=>({id:e.id,summary:e.title,start:{dateTime:e.start},end:{dateTime:e.end}})),{now:new Date(now),timeZone:zone});
 assert.ok(shaped.today.some(e=>e.id==='next'));assert.equal(shaped.events.length,7);
 assert.equal(buildAttention({modules:{calendar:entry(shaped)}},{now}).notices[0].title,'next');
});
test('reminders only gain urgency from a real due date; focus is a separate choice',()=>{
 const s=state();s.modules.notion=entry({items:[{id:'a',title:'Plain task'},{id:'b',title:'Due task',due:'2026-09-05'},{id:'c',title:'Future',due:'2026-09-06'}]});
 assert.equal(buildAttention(s,{now}).notices[0].title,'Due task');
 assert.equal(tasksFor(s.modules.notion.data,'a')[0].title,'Plain task');
});
test('Notion extracts a named deadline and excludes completed tasks',()=>{
 const props=pickProperties({properties:{Name:{type:'title'},Deadline:{type:'date'},Done:{type:'checkbox'},Created:{type:'created_time'}}});
 assert.equal(props.due,'Deadline');
 const page=(id,done)=>({id,properties:{Name:{title:[{plain_text:'Reminder'}]},Deadline:{date:{start:'2026-09-05'}},Done:{checkbox:done}}});
 assert.deepEqual(toTodos([page('open',false),page('done',true)],props),[{id:'open',title:'Reminder',area:'other',due:'2026-09-05'}]);
});
test('today reminders rank ahead of the backlog; most recent overdue is next',()=>{
 const items=[{id:'old',title:'Old',due:'2026-08-01'},{id:'new',title:'Recent',due:'2026-09-04'},{id:'today',title:'Today',due:'2026-09-05'}];
 assert.deepEqual(tasksFor({items},null,now,zone).map(t=>t.id),['today','new','old']);
 const s=state();s.modules.notion=entry({items});assert.equal(buildAttention(s,{now}).notices[0].label,'1 due today');
});
test('countdowns advance at local midnight even before the next source refresh',()=>{
 const entry={fetchedAt:Date.parse('2026-09-06T06:59:00Z'),stale:false,data:{items:[{label:'Trip',days:1},{label:'Expired',days:0}]}};
 assert.deepEqual(horizonFor(entry,Date.parse('2026-09-06T07:01:00Z'),zone).items,[{label:'Trip',days:0}]);
});
test('leave-by source retains a just-due departure instead of dropping it',async()=>{
 resetCache();const e={...event('Dinner',28,60),location:'Example venue'};
 const fetchFn=async url=>new Response(JSON.stringify(String(url).includes('nominatim')?[{lat:'47.6',lon:'-122.3'}]:{routes:[{legs:[{duration:1320,distance:1000}]}]}));
 const result=await leavebyModule.fetch({config:{homeLat:47.6,homeLon:-122.3,timezone:zone},now:new Date(now),getModule:()=>({data:{today:[e]}}),fetchFn,log:{warn(){}}});
 assert.equal(result.leaveByMs,now-2*MINUTE);
});
