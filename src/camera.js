// Reuse the configured, authenticated Pi connection. Never accept client URLs.
export function createCameraHandler({config, request=fetch}) {
  let pending=null, latest=null, lastAttempt=0;
  async function read() {
    if (!config.display.piAgentUrl || !config.display.piAgentToken) return {error:'Camera connection not configured'};
    try {
      const url=new URL(config.display.piAgentUrl);
      url.port='8421';url.pathname='/frame.jpg';url.search='';url.hash='';
      const response=await request(url,{headers:{authorization:`Bearer ${config.display.piAgentToken}`},signal:AbortSignal.timeout(3000)});
      if(!response.ok) {
        const status=await response.json().catch(()=>({}));
        const known=['Camera not connected','Starting Logitech Brio','Camera signal lost','Camera capture unavailable'];
        return {error:known.includes(status.error)?status.error:'Camera unavailable'};
      }
      if(!response.headers.get('content-type')?.startsWith('image/jpeg'))return {error:'Camera frame unavailable'};
      const reader=response.body.getReader();
      const chunks=[];let size=0;
      try {
        while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>2_000_000)throw new Error('Frame too large');chunks.push(Buffer.from(value));}
      } finally {await reader.cancel().catch(()=>{});}
      const frame=Buffer.concat(chunks);
      if(frame.length<4||frame[0]!==255||frame[1]!==216||frame.at(-2)!==255||frame.at(-1)!==217)return {error:'Camera frame unavailable'};
      return {frame};
    } catch {return {error:'Camera connection lost'};}
  }
  return async (_req,res)=>{
    res.set('Cache-Control','no-store');
    const ttl=latest?.frame?100:1000;
    if(!pending&&(!latest||Date.now()-lastAttempt>ttl)) {
      pending=read().then(result=>{latest=result;lastAttempt=Date.now();return result;}).finally(()=>{pending=null;});
    }
    const result=pending?await pending:latest;
    if(res.destroyed)return;
    if(result.frame)return res.type('image/jpeg').send(result.frame);
    return res.status(503).json({error:result.error});
  };
}
