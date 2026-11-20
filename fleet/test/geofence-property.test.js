import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { isOutsideGeofence, outsideZone, validCircle, distanceMeters, implausiblePosition,
  point, validSettings, vehicleStatus, simplifyTrack } from '../src/domain.js';

test('належність точки не змінюється при однаковому зсуві полігона й точки',()=>{
  const coord=fc.integer({min:-30,max:30});
  fc.assert(fc.property(coord,coord,coord,coord,(px,py,dx,dy)=>{
    const polygon=[[-10,-10],[10,-10],[10,10],[-10,10]];
    const shift=([x,y])=>[x+dx,y+dy];
    assert.equal(isOutsideGeofence([px,py],polygon),isOutsideGeofence(shift([px,py]),polygon.map(shift)));
  }),{seed:19,numRuns:500});
});

test('GPS: межа 250 км/год, стрибок і некоректний час',()=>{
  const a={lat:0,lon:0,ts:0};
  const b={lat:2,lon:0,ts:3600000};
  assert.equal(implausiblePosition(a,b),false);
  assert.equal(implausiblePosition(a,{...b,lat:3}),true);
  assert.equal(implausiblePosition(a,{...b,ts:0}),false);
  assert.equal(implausiblePosition(a,{...b,lat:NaN}),false);
});

test('кругова геозона: центр, межа, зовнішня точка й дійсність радіуса',()=>{
  const position={lat:50.43,lon:30.51};
  const circle={...position,radiusM:100};
  assert.equal(validCircle(circle),true);
  assert.equal(validCircle({...circle,radiusM:5001}),false);
  assert.equal(validCircle({...circle,lon:181}),false);
  assert.equal(validCircle(null),false);
  assert.equal(outsideZone(position,circle),false);
  const outer={...position,lat:50.44};
  assert.equal(outsideZone(outer,circle),true);
  assert.equal(outsideZone(outer,{...circle,radiusM:distanceMeters(position,outer)}),false);
  assert.equal(outsideZone(position,{polygon:[[30.5,50.4],[30.6,50.4],[30.6,50.5],[30.5,50.5]]}),false);
});

test('гаверсинус враховує широту для зміни довготи',()=>{
  const a={lat:60,lon:0}, b={lat:60.1,lon:1};
  assert.ok(Math.abs(distanceMeters(a,b)-56610)<250);
  assert.ok(Math.abs(distanceMeters(a,b)-distanceMeters(b,a))<1e-8);
  const start={...a,ts:1750000000000};
  assert.equal(implausiblePosition(start,{...b,ts:start.ts+600000}),true);
  assert.equal(implausiblePosition({...start,lon:Infinity},{...b,ts:start.ts+600000}),false);
});

test('телеметрія та налаштування приймають усі задокументовані межі',()=>{
  for (const [metric, lower, upper] of [
    ['lat',-90,90],['lon',-180,180],['engine',0,1],['speed',0,250],['fuel',0,100],
  ]) {
    for (const value of [lower,upper]) assert.deepEqual(point({ts:0,metric,value}),{ts:0,metric,value});
    for (const value of [lower-1,upper+1]) assert.equal(point({ts:0,metric,value}),null);
  }
  assert.equal(validSettings({speedLimit:30,fuelMinPercent:5}),true);
  assert.equal(validSettings({speedLimit:130,fuelMinPercent:30}),true);
  assert.equal(validSettings({speedLimit:135,fuelMinPercent:10}),false);
  assert.equal(validSettings({speedLimit:60,fuelMinPercent:31}),false);
  assert.equal(validSettings({speedLimit:60,fuelMinPercent:5.5}),false);
  assert.equal(validCircle({lat:90,lon:-180,radiusM:5000}),true);
  assert.equal(validCircle({lat:91,lon:0,radiusM:5000}),false);
  assert.equal(validCircle({lat:0,lon:0,radiusM:100.5}),false);
  const latest={lat:{ts:1,value:50.43},lon:{ts:1,value:30.51},fuel:{value:10}};
  assert.equal(vehicleStatus(latest,{speedLimit:60,fuelMinPercent:10},180001),'warning');
  assert.equal(vehicleStatus({...latest,lon:{...latest.lon,ts:2}},{speedLimit:60,fuelMinPercent:10},2),'offline');
});

test('обхід контуру обробляє похилу межу, а спрощення зберігає поворот',()=>{
  const triangle=[[0,0],[8,4],[0,8]];
  for (const p of [[4,2],[4,6],[0,6],[3,4],[8,4]]) assert.equal(isOutsideGeofence(p,triangle),false);
  for (const p of [[4,1],[4,7],[9,4],[0,10],[7,3]]) assert.equal(isOutsideGeofence(p,triangle),true);
  const route = [
    {ts:0,lat:50,lon:30},
    {ts:1,lat:50.05,lon:30},
    {ts:2,lat:50.1,lon:30},
    {ts:3,lat:50.1,lon:30.05},
    {ts:4,lat:50.1,lon:30.1},
  ];
  assert.deepEqual(simplifyTrack(route,3).map(p=>p.ts),[0,2,4]);
  assert.deepEqual(simplifyTrack(route,2).map(p=>p.ts),[0,4]);
  assert.deepEqual(simplifyTrack(route,5),route);
});
