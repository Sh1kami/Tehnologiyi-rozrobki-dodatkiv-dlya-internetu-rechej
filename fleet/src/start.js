import {createFleet} from './server.js';

const env=process.env;
const fleet=createFleet({database:env.DB_PATH||'fleet.sqlite',mqttUrl:env.MQTT_URL||'mqtt://127.0.0.1:1883',
  secret:env.JWT_SECRET,password:env.FLEET_PASSWORD,origin:env.CORS_ORIGIN});
fleet.http.listen(Number(env.PORT||3080),env.BIND||'127.0.0.1',()=>console.log(JSON.stringify({event:'fleet_started',port:fleet.http.address().port})));
for(const sig of ['SIGTERM','SIGINT'])process.once(sig,()=>fleet.close().then(()=>process.exit(0)));
