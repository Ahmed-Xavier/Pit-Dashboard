#!/usr/bin/env node
// Dependency-free Foxglove WebSocket load source for the Pit dashboard.
// Usage: node tools/mock_bridge.mjs [--port 8765] [--scan-points 1440]
// Rates are overridable as --tf-hz 100, --scan-hz 10, etc.
import net from 'node:net';
import { createHash } from 'node:crypto';

const defaults = { port: 8765, tfHz: 100, imuHz: 100, jointStatesHz: 40,
  odomHz: 40, wheelOdomHz: 40, scanHz: 10, globalHz: 10, localHz: 10,
  waypointMarkersHz: 0, plannerMarkersHz: 10, worldMarkersHz: 1, fixHz: 5,
  progressHz: 10, scanPoints: 1440, plannerArcs: 11, plannerPoints: 81,
  waypointCount: 8 };
const opts = { ...defaults };
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith('--')) continue;
  const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (i + 1 < process.argv.length) opts[key] = Number(process.argv[++i]);
}

const schemas = {
  '/tf': 'tf2_msgs/msg/TFMessage', '/tf_static': 'tf2_msgs/msg/TFMessage',
  '/imu/data': 'sensor_msgs/msg/Imu', '/joint_states': 'sensor_msgs/msg/JointState',
  '/odom': 'nav_msgs/msg/Odometry', '/wheel/odom': 'nav_msgs/msg/Odometry',
  '/odometry/global': 'nav_msgs/msg/Odometry', '/odometry/local': 'nav_msgs/msg/Odometry',
  '/scan': 'sensor_msgs/msg/LaserScan', '/waypoints/markers': 'visualization_msgs/msg/MarkerArray',
  '/planner/markers': 'visualization_msgs/msg/MarkerArray', '/world_markers': 'visualization_msgs/msg/MarkerArray',
  '/fix': 'sensor_msgs/msg/NavSatFix', '/track/progress': 'std_msgs/msg/Float32',
  '/waypoints/guidance': 'std_msgs/msg/Float32MultiArray',
  '/planner/status': 'std_msgs/msg/String', '/safety/gate_status': 'std_msgs/msg/String',
  '/obstacle_stop': 'std_msgs/msg/Bool', '/cmd_vel': 'geometry_msgs/msg/Twist',
  '/esp32/encoder': 'std_msgs/msg/Int32', '/esp32/motor_cmd': 'std_msgs/msg/Int16',
  '/esp32/servo_cmd': 'std_msgs/msg/Int16'
};
const commonSchemas = `MSG: builtin_interfaces/msg/Time\nint32 sec\nuint32 nanosec\n===\nMSG: std_msgs/msg/Header\nbuiltin_interfaces/Time stamp\nstring frame_id\n===\nMSG: geometry_msgs/msg/Point\nfloat64 x\nfloat64 y\nfloat64 z\n===\nMSG: geometry_msgs/msg/Vector3\nfloat64 x\nfloat64 y\nfloat64 z\n===\nMSG: geometry_msgs/msg/Quaternion\nfloat64 x\nfloat64 y\nfloat64 z\nfloat64 w\n===\nMSG: geometry_msgs/msg/Pose\ngeometry_msgs/Point position\ngeometry_msgs/Quaternion orientation\n===\nMSG: geometry_msgs/msg/Twist\ngeometry_msgs/Vector3 linear\ngeometry_msgs/Vector3 angular\n===\nMSG: geometry_msgs/msg/Transform\ngeometry_msgs/Vector3 translation\ngeometry_msgs/Quaternion rotation\n===\nMSG: geometry_msgs/msg/TransformStamped\nstd_msgs/Header header\nstring child_frame_id\ngeometry_msgs/Transform transform\n===\nMSG: geometry_msgs/msg/PoseWithCovariance\ngeometry_msgs/Pose pose\nfloat64[36] covariance\n===\nMSG: geometry_msgs/msg/TwistWithCovariance\ngeometry_msgs/Twist twist\nfloat64[36] covariance\n===\nMSG: std_msgs/msg/ColorRGBA\nfloat32 r\nfloat32 g\nfloat32 b\nfloat32 a\n===\nMSG: builtin_interfaces/msg/Duration\nint32 sec\nuint32 nanosec\n===\nMSG: std_msgs/msg/MultiArrayDimension\nstring label\nuint32 size\nuint32 stride\n===\nMSG: std_msgs/msg/MultiArrayLayout\nstd_msgs/MultiArrayDimension[] dim\nuint32 data_offset\n===\nMSG: sensor_msgs/msg/NavSatStatus\nint8 status\nuint16 service\n`;
const primarySchemas = {
  'tf2_msgs/msg/TFMessage': 'geometry_msgs/TransformStamped[] transforms',
  'sensor_msgs/msg/Imu': 'std_msgs/Header header\ngeometry_msgs/Quaternion orientation\nfloat64[9] orientation_covariance\ngeometry_msgs/Vector3 angular_velocity\nfloat64[9] angular_velocity_covariance\ngeometry_msgs/Vector3 linear_acceleration\nfloat64[9] linear_acceleration_covariance',
  'sensor_msgs/msg/JointState': 'std_msgs/Header header\nstring[] name\nfloat64[] position\nfloat64[] velocity\nfloat64[] effort',
  'nav_msgs/msg/Odometry': 'std_msgs/Header header\nstring child_frame_id\n geometry_msgs/PoseWithCovariance pose\ngeometry_msgs/TwistWithCovariance twist',
  'sensor_msgs/msg/LaserScan': 'std_msgs/Header header\nfloat32 angle_min\nfloat32 angle_max\nfloat32 angle_increment\nfloat32 time_increment\nfloat32 scan_time\nfloat32 range_min\nfloat32 range_max\nfloat32[] ranges\nfloat32[] intensities',
  'sensor_msgs/msg/NavSatFix': 'std_msgs/Header header\nsensor_msgs/NavSatStatus status\nfloat64 latitude\nfloat64 longitude\nfloat64 altitude\nfloat64[9] position_covariance\nuint8 position_covariance_type',
  'visualization_msgs/msg/MarkerArray': 'visualization_msgs/Marker[] markers',
  'std_msgs/msg/Float32': 'float32 data',
  'std_msgs/msg/Float32MultiArray': 'std_msgs/MultiArrayLayout layout\nfloat32[] data',
  'std_msgs/msg/Int16': 'int16 data', 'std_msgs/msg/Int32': 'int32 data',
  'std_msgs/msg/Bool': 'bool data', 'std_msgs/msg/String': 'string data',
  'geometry_msgs/msg/Twist': 'geometry_msgs/Vector3 linear\ngeometry_msgs/Vector3 angular'
};
const markerSchema = `MSG: visualization_msgs/msg/Marker\nstd_msgs/Header header\nstring ns\nint32 id\nint32 type\nint32 action\ngeometry_msgs/Pose pose\ngeometry_msgs/Vector3 scale\nstd_msgs/ColorRGBA color\nbuiltin_interfaces/Duration lifetime\nbool frame_locked\ngeometry_msgs/Point[] points\nstd_msgs/ColorRGBA[] colors\nstring text\nstring mesh_resource\nbool mesh_use_embedded_materials`;
function schemaFor(type) {
  const primary = primarySchemas[type] || '';
  const clean = primary.split('\n').map(line => line.startsWith(' ') ? line.slice(1) : line).join('\n');
  return `MSG: ${type}\n${clean}\n===\n${commonSchemas}${type === 'visualization_msgs/msg/MarkerArray' ? `===\n${markerSchema}\n` : ''}`;
}
const topics = Object.keys(schemas).map((topic, id) => ({ id: id + 1, topic,
  encoding: 'cdr', schemaName: schemas[topic], schema: schemaFor(schemas[topic]) }));
const topicRates = {
  '/tf': opts.tfHz, '/tf_static': 0, '/imu/data': opts.imuHz,
  '/joint_states': opts.jointStatesHz, '/odom': opts.odomHz,
  '/wheel/odom': opts.wheelOdomHz, '/odometry/global': opts.globalHz,
  '/odometry/local': opts.localHz, '/scan': opts.scanHz,
  '/waypoints/markers': opts.waypointMarkersHz, '/planner/markers': opts.plannerMarkersHz,
  '/world_markers': opts.worldMarkersHz, '/fix': opts.fixHz,
  '/track/progress': opts.progressHz, '/waypoints/guidance': opts.progressHz,
  '/planner/status': 10, '/safety/gate_status': 10, '/obstacle_stop': 10,
  '/cmd_vel': 50, '/esp32/encoder': 50, '/esp32/motor_cmd': 50, '/esp32/servo_cmd': 50
};

class Cdr {
  constructor() { this.b = Buffer.alloc(256); this.o = 4; this.b[0] = 0; this.b[1] = 1; }
  ensure(n) { if (this.o + n > this.b.length) { const b = Buffer.alloc(Math.max(this.b.length * 2, this.o + n)); this.b.copy(b); this.b = b; } }
  align(n) { const at = Math.ceil(this.o / n) * n; this.ensure(at - this.o); this.o = at; }
  u8(v) { this.ensure(1); this.b.writeUInt8(v, this.o++); }
  i8(v) { this.ensure(1); this.b.writeInt8(v, this.o++); }
  bool(v) { this.u8(v ? 1 : 0); }
  i16(v) { this.align(2); this.ensure(2); this.b.writeInt16LE(v, this.o); this.o += 2; }
  u16(v) { this.align(2); this.ensure(2); this.b.writeUInt16LE(v, this.o); this.o += 2; }
  i32(v) { this.align(4); this.ensure(4); this.b.writeInt32LE(v, this.o); this.o += 4; }
  u32(v) { this.align(4); this.ensure(4); this.b.writeUInt32LE(v, this.o); this.o += 4; }
  f32(v) { this.align(4); this.ensure(4); this.b.writeFloatLE(v, this.o); this.o += 4; }
  f64(v) { this.align(8); this.ensure(8); this.b.writeDoubleLE(v, this.o); this.o += 8; }
  str(s) { const b = Buffer.from(s + '\0'); this.u32(b.length); this.ensure(b.length); b.copy(this.b, this.o); this.o += b.length; }
  vec3(x=0,y=0,z=0) { this.f64(x); this.f64(y); this.f64(z); }
  quat(yaw=0) { this.f64(0); this.f64(0); this.f64(Math.sin(yaw/2)); this.f64(Math.cos(yaw/2)); }
  header(frame='map') { this.i32(Math.floor(Date.now()/1000)); this.u32((Date.now()%1000)*1e6); this.str(frame); }
  finish() { return this.b.subarray(0, this.o); }
}
function writeOdom(c, frame='map', child='base_footprint') {
  c.header(frame); c.str(child); c.vec3(20, 0, 0); c.quat(0.02);
  for (let i=0;i<36;i++) c.f64(0); c.vec3(4,0,0); c.vec3(0,0,0);
  for (let i=0;i<36;i++) c.f64(0);
}
function writeTransform(c, parent, child, x=0, yaw=0) { c.header(parent); c.str(child); c.vec3(x,0,0); c.quat(yaw); }
function writeMarker(c, {ns='mock',id=0,type=2,action=0,x=0,y=0,z=0,points=[],text='',mesh='',color=[.1,.7,1,1]}={}) {
  c.header('map'); c.str(ns); c.i32(id); c.i32(type); c.i32(action);
  c.vec3(x,y,z); c.quat(); c.vec3(type===2?.35:.08,type===2?.35:0.08,type===2?.35:0.08);
  for (const v of color) c.f32(v); c.i32(0); c.u32(0); c.bool(false);
  c.u32(points.length); for (const p of points) c.vec3(p[0],p[1],p[2]||0);
  c.u32(0); c.str(text); c.str(mesh); c.bool(false);
}
function payload(topic, n) {
  const c = new Cdr(); const sec = n / 100;
  switch (topic) {
    case '/tf': c.u32(2); writeTransform(c,'map','base_footprint',20+Math.sin(sec),.2); writeTransform(c,'odom','base_footprint',20,.2); break;
    case '/tf_static': c.u32(1); writeTransform(c,'base_footprint','base_link',0,0); break;
    case '/imu/data': c.header('imu_link'); c.quat(); for(let i=0;i<9;i++) c.f64(0); c.vec3(0,0,.02); for(let i=0;i<9;i++) c.f64(0); c.vec3(0,0,9.81); for(let i=0;i<9;i++) c.f64(0); break;
    case '/joint_states': c.header(); c.u32(4); for(const s of ['front_left_steer_joint','front_right_steer_joint','rear_left_wheel_joint','rear_right_wheel_joint']) c.str(s); c.u32(4); for(let i=0;i<4;i++) c.f64(.1); c.u32(0); c.u32(0); break;
    case '/odom': case '/wheel/odom': case '/odometry/global': case '/odometry/local': writeOdom(c,topic==='/odometry/local'?'odom':'map'); break;
    case '/scan': c.header('lidar_link'); c.f32(-Math.PI); c.f32(Math.PI); c.f32(2*Math.PI/opts.scanPoints); c.f32(0); c.f32(.1); c.f32(.15); c.f32(12); c.u32(opts.scanPoints); for(let i=0;i<opts.scanPoints;i++) c.f32(2+Math.sin(i*.04)*.3); c.u32(0); break;
    case '/fix': c.header('gps_link'); c.i8(0); c.u16(1); c.f64(50.3568); c.f64(18.4027); c.f64(270); for(let i=0;i<9;i++) c.f64(0); c.u8(2); break;
    case '/track/progress': c.f32((n%100)/100); break;
    case '/waypoints/guidance': c.u32(0); c.u32(0); c.u32(4); for(const v of [5,.1,0,opts.waypointCount]) c.f32(v); break;
    case '/waypoints/markers': {
      const count=opts.waypointCount; c.u32(1+count*3); writeMarker(c,{ns:'',type:0,action:3});
      const pts=Array.from({length:count},(_,i)=>[i*4,Math.sin(i*.7)*2,0]);
      writeMarker(c,{ns:'waypoints',id:1,type:4,points:pts});
      pts.forEach(([x,y],i)=>{ writeMarker(c,{ns:'waypoints',id:1000+i,type:2,x,y}); writeMarker(c,{ns:'waypoints',id:2000+i,type:9,x,y,z:.5,text:String(i+1)}); }); break;
    }
    case '/planner/markers': {
      c.u32(opts.plannerArcs+1); writeMarker(c,{ns:'',type:0,action:3});
      for(let a=0;a<opts.plannerArcs;a++) { const pts=[]; for(let i=0;i<opts.plannerPoints;i++){const x=i*.025;pts.push([x,Math.sin(a*.16)*x*x*.04]);} const color=a===5?[1,.85,0,1]:[0,1,0,1]; writeMarker(c,{ns:'candidate_arcs',id:a,type:4,points:pts,color}); } break;
    }
    case '/world_markers': c.u32(1); writeMarker(c,{ns:'ground',id:0,type:10,mesh:'package://simulation/worlds/models/silesia_ring/meshes/silesia_ring.glb'}); break;
    case '/planner/status': c.str('OK'); break;
    case '/safety/gate_status': c.str('OPEN'); break;
    case '/obstacle_stop': c.bool(false); break;
    case '/cmd_vel': c.vec3(4,0,0); c.vec3(0,0,0); break;
    case '/esp32/encoder': c.i32(n); break;
    case '/esp32/motor_cmd': case '/esp32/servo_cmd': c.i16(0); break;
  }
  return c.finish();
}

const serviceList = [
  {id:101,name:'/waypoints/add_here',type:'std_srvs/srv/Trigger',request:{encoding:'cdr',schema:'MSG: std_srvs/srv/Trigger_Request\n---\nMSG: std_srvs/srv/Trigger_Response\nbool success\nstring message'}},
  {id:102,name:'/waypoints/start',type:'std_srvs/srv/Trigger'},
  {id:103,name:'/waypoints/undo',type:'std_srvs/srv/Trigger'},
  {id:104,name:'/waypoints/clear',type:'std_srvs/srv/Trigger'}
];
let clientPublishChannel = null;
const server = net.createServer(socket => {
  let pending = Buffer.alloc(0), upgraded = false, subscriptions = new Map();
  const sendFrame = (opcode, body) => {
    if (socket.destroyed || !socket.writable) return;
    const b=Buffer.from(body); let head;
    if(b.length<126) head=Buffer.from([0x80|opcode,b.length]);
    else if(b.length<65536){head=Buffer.alloc(4);head[0]=0x80|opcode;head[1]=126;head.writeUInt16BE(b.length,2);}
    else {head=Buffer.alloc(10);head[0]=0x80|opcode;head[1]=127;head.writeBigUInt64BE(BigInt(b.length),2);}
    socket.write(Buffer.concat([head,b]));
  };
  const sendJson = obj => sendFrame(1,Buffer.from(JSON.stringify(obj)));
  const sendBinary = b => sendFrame(2,b);
  function onJson(m) {
    if(m.op==='subscribe') for(const sub of m.subscriptions||[]) subscriptions.set(sub.channelId,sub.id);
    if(m.op==='advertise' && (m.channels||[]).some(c=>c.topic==='/clicked_point')) clientPublishChannel=(m.channels||[]).find(c=>c.topic==='/clicked_point').id;
    if(m.op==='unadvertise') clientPublishChannel=null;
  }
  function onBinary(b) {
    const op=b[0];
    if(op===1 && clientPublishChannel!==null) {
      const channel=b.readUInt32LE(1), d=b.subarray(5); if(channel===clientPublishChannel && d.length>=44) {
        // PointStamped CDR: encapsulation, Header time/string, then Point x/y/z.
        const frameLen=d.readUInt32LE(12), frame=d.toString('utf8',16,16+frameLen-1), at=4+Math.ceil((16+frameLen-4)/8)*8;
        const x=d.readDoubleLE(at), y=d.readDoubleLE(at+8);
        console.log(`[clientPublish] /clicked_point x=${x.toFixed(3)} y=${y.toFixed(3)} frame_id=${frame}`);
      }
    }
    if(op===2) {
      const serviceId=b.readUInt32LE(1), callId=b.readUInt32LE(5), service=serviceList.find(s=>s.id===serviceId);
      const name=service?.name||'unknown';
      const msg=`Mock accepted ${name}`;
      const c=new Cdr(); c.bool(true); c.str(msg);
      const enc=Buffer.from('cdr'); const out=Buffer.alloc(13+enc.length+c.o);
      out[0]=3; out.writeUInt32LE(serviceId,1); out.writeUInt32LE(callId,5); out.writeUInt32LE(enc.length,9); enc.copy(out,13);
      c.finish().copy(out,13+enc.length);
      sendBinary(out); console.log(`[service] ${name} callId=${callId}`);
    }
  }
  function parseFrames() {
    while(pending.length>=2) {
      const opcode=pending[0]&15, masked=!!(pending[1]&128); let len=pending[1]&127, head=2;
      if(len===126){if(pending.length<4)return;len=pending.readUInt16BE(2);head=4;}
      else if(len===127){if(pending.length<10)return;len=Number(pending.readBigUInt64BE(2));head=10;}
      if(masked)head+=4; if(pending.length<head+len)return;
      let body=pending.subarray(head,head+len); if(masked){const mask=pending.subarray(head-4,head);body=Buffer.from(body);for(let i=0;i<len;i++)body[i]^=mask[i%4];}
      pending=pending.subarray(head+len);
      if(opcode===8){socket.end();return;} if(opcode===9){sendFrame(10,body);continue;}
      if(opcode===1) {try{onJson(JSON.parse(body.toString()));}catch{}}
      if(opcode===2)onBinary(body);
    }
  }
  socket.on('data', chunk => {
    pending=Buffer.concat([pending,chunk]);
    if(!upgraded) {
      const end=pending.indexOf('\r\n\r\n'); if(end<0)return;
      const req=pending.subarray(0,end).toString(); const key=req.match(/Sec-WebSocket-Key:\s*(.+)/i)?.[1]?.trim();
      const offered = req.match(/Sec-WebSocket-Protocol:\s*(.+)/i)?.[1]?.split(',').map(value => value.trim()) ?? [];
      const protocol = offered.includes('foxglove.sdk.v1') ? 'foxglove.sdk.v1' : offered.includes('foxglove.websocket.v1') ? 'foxglove.websocket.v1' : null;
      if(!key || !protocol){socket.destroy();return;}
      const accept=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${protocol}\r\n\r\n`);
      pending=pending.subarray(end+4);upgraded=true;
      console.log('[bridge] WebSocket client upgraded');
      sendJson({op:'serverInfo',name:'pit-dashboard-mock',capabilities:['clientPublish','services'],supportedEncodings:['cdr']});
      sendJson({op:'advertise',channels:topics});
      sendJson({op:'advertiseServices',services:serviceList});
    }
    parseFrames();
  });
  socket.on('error', error => console.warn(`[bridge] socket: ${error.code || error.message}`));
  socket.on('close',()=>console.log('[bridge] client closed'));
  const timers=[]; let tick=0;
  for(const [topic,hz] of Object.entries(topicRates)) {
    if(!hz)continue;
    if(topic==='/tf_static')continue;
    const ms=Math.max(1,1000/hz), channel=topics.find(t=>t.topic===topic);
    timers.push(setInterval(()=>{const subId=subscriptions.get(channel.id);if(!upgraded||subId===undefined)return;const data=payload(topic,tick++);const f=Buffer.alloc(13+data.length);f[0]=1;f.writeUInt32LE(subId,1);f.writeBigUInt64LE(BigInt(Date.now())*1000000n,5);data.copy(f,13);sendBinary(f);},ms));
  }
  const staticTimer=setTimeout(()=>{const channel=topics.find(t=>t.topic==='/tf_static');const subId=subscriptions.get(channel.id);if(upgraded&&subId!==undefined){const data=payload('/tf_static',0),f=Buffer.alloc(13+data.length);f[0]=1;f.writeUInt32LE(subId,1);f.writeBigUInt64LE(BigInt(Date.now())*1000000n,5);data.copy(f,13);sendBinary(f);}},100);
  socket.on('close',()=>{timers.forEach(clearInterval);clearTimeout(staticTimer);});
});
server.listen(opts.port,'127.0.0.1',()=>console.log(`[mock] foxglove.sdk.v1 + foxglove.websocket.v1 on ws://127.0.0.1:${opts.port}; ${opts.scanPoints}-point scan; ${opts.plannerArcs} arcs × ${opts.plannerPoints} points`));
