import test from 'node:test';
import assert from 'node:assert/strict';
import { sunlightFor } from '../public/attention.js';
import { shapeAstro, buildUrl } from '../src/modules/astro.js';
const zone='America/Los_Angeles';
const at=(hour,minute=0)=>Date.parse(`2026-09-05T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00-07:00`);
const data={sunsetAt:new Date(at(19,41)).toISOString(),uvHours:[8,9,10,11,12,13,14,15,16,17,18,19,20].map((h,i)=>({at:new Date(at(h)).toISOString(),uv:[.2,.7,1.7,3.5,4.6,5.3,5.5,5.1,3.9,2.4,1.1,.5,.1][i]}))};
const render=(hour,minute=0,d=data)=>sunlightFor({fetchedAt:at(hour,minute),data:d},at(hour,minute),zone);
test('morning shows the UV peak still ahead and sunset',()=>{
 const result=render(9);assert.equal(result[0].title,'UV 5.5 later');assert.equal(result[0].detail,'Peak at 2:00 PM');assert.equal(result[1].title,'Sunset 7:41 PM');
});
test('afternoon uses interpolated current UV and ignores a higher past peak',()=>{
 const result=render(16,30);assert.equal(result[0].title,'UV 3.2 now');assert.equal(result[0].detail,null);
});
test('UV disappears when remaining forecast is <=2; sunset appears within two hours',()=>{
 assert.deepEqual(render(17,40),[]); // 121 minutes before sunset, UV already <2.
 const result=render(17,41);assert.equal(result.length,1);assert.equal(result[0].kind,'sunset');assert.equal(result[0].detail,'In 2h');
});
test('no sunset after it passes; tomorrow UV never masquerades as today',()=>{
 assert.deepEqual(render(20,0,{...data,uvHours:[...data.uvHours,{at:'2026-09-06T12:00:00-07:00',uv:8}]}),[]);
});
test('missing UV is not zero or today’s maximum; stale forecast is hidden',()=>{
 assert.deepEqual(render(12,0,{uv:8,sunsetAt:data.sunsetAt}),[]);
 assert.equal(render(19,0,{sunsetAt:data.sunsetAt})[0].kind,'sunset');
 assert.deepEqual(sunlightFor({data,fetchedAt:at(12),stale:true},at(12),zone),[]);
 assert.deepEqual(render(12,0,{}),[]);
});
test('astro returns zoned sunset instants and valid hourly UV only',()=>{
 const raw={daily:{time:['2026-09-05'],sunrise:['2026-09-05T06:33'],sunset:['2026-09-05T19:41']},hourly:{time:['2026-09-05T12:00','2026-09-05T13:00','2026-09-05T14:00'],uv_index:[null,4.5,-1]}};
 const shaped=shapeAstro(raw,{now:new Date(at(12)),timeZone:zone});
 assert.equal(shaped.sunsetAt,'2026-09-06T02:41:00.000Z');assert.equal(shaped.sunrise,'06:33');assert.deepEqual(shaped.uvHours,[{at:'2026-09-05T20:00:00.000Z',uv:4.5}]);
 assert.equal(new URL(buildUrl({lat:47.6,lon:-122.3,timezone:zone})).searchParams.get('hourly'),'uv_index');
});
