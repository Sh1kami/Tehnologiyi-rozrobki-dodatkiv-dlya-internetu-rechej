import {io} from 'socket.io-client';
const base=new URL(process.env.FLEET_URL||'http://127.0.0.1:8080');
if(!['127.0.0.1','localhost'].includes(base.hostname)) throw Error('This smoke check is for the local training stack.');
const login=await fetch(new URL('/api/v1/auth/login',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'dispatch-west',password:process.env.FLEET_PASSWORD})});
if(!login.ok) throw Error('login returned '+login.status);
const {accessToken}=await login.json();
const socket=io(base.origin,{auth:{token:accessToken},path:process.env.WS_PATH||'/socket.io',transports:['websocket'],timeout:5000,reconnection:false});
try{
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('fleet:ready timed out')),10000);
    socket.once('fleet:ready',message=>{
      clearTimeout(timer);
      if(message?.role==='dispatcher')resolve();else reject(new Error('unexpected role'));
    });
    socket.once('connect_error',error=>{clearTimeout(timer);reject(error);});
  });
  const headers={Authorization:'Bearer '+accessToken};
  const health=await(await fetch(new URL('/api/v1/health',base))).json();
  const metrics=await(await fetch(new URL('/api/v1/metrics',base),{headers})).json();
  if(health.status!=='ok'||metrics.dispatchers<1)throw Error('health or metrics check failed');
  console.log(JSON.stringify({health,ws:'fleet:ready',metrics},null,2));
}finally{socket.close();}
