import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createCameraHandler} from '../src/camera.js';

const config={display:{piAgentUrl:'http://pi.test:8420',piAgentToken:'fixture'}};
const jpeg=Buffer.from([255,216,1,2,255,217]);
async function endpoint(t,request){
  const app=express();app.get('/camera',createCameraHandler({config,request}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(()=>new Promise(r=>server.close(r)));
  return `http://127.0.0.1:${server.address().port}/camera`;
}
test('camera requests authenticate to fixed Pi and coalesce concurrent viewers',async t=>{
  let calls=0;
  const url=await endpoint(t,async (upstream,options)=>{
    calls++;assert.equal(String(upstream),'http://pi.test:8421/frame.jpg');
    assert.equal(options.headers.authorization,'Bearer fixture');
    await new Promise(r=>setTimeout(r,30));
    return new Response(jpeg,{headers:{'content-type':'image/jpeg'}});
  });
  const results=await Promise.all([fetch(url+'?url=http://other.test'),fetch(url)]);
  for(const result of results){assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');assert.deepEqual(Buffer.from(await result.arrayBuffer()),jpeg);}
  assert.equal(calls,1);
});
test('camera disconnect and malformed images never masquerade as live video',async t=>{
  const missing=await endpoint(t,async()=>new Response(JSON.stringify({error:'Camera not connected'}),{status:503}));
  const result=await fetch(missing);assert.equal(result.status,503);assert.deepEqual(await result.json(),{error:'Camera not connected'});
  const invalid=await endpoint(t,async()=>new Response('not a JPEG',{headers:{'content-type':'image/jpeg'}}));
  assert.equal((await fetch(invalid)).status,503);
});
