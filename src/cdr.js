// Minimal ROS 2 CDR reader for message types published by Autonomous-outdoor-RC.
// Foxglove's binary message frame contains the CDR payload including its 4-byte
// encapsulation header.
class CdrReader {
  constructor(buffer) {
    this.view = new DataView(buffer);
    this.littleEndian = this.view.getUint8(1) === 1;
    this.offset = 4;
  }

  align(size) { this.offset = Math.ceil(this.offset / size) * size; }
  i8() { return this.view.getInt8(this.offset++); }
  u8() { return this.view.getUint8(this.offset++); }
  bool() { return this.u8() !== 0; }
  i16() { this.align(2); const v = this.view.getInt16(this.offset, this.littleEndian); this.offset += 2; return v; }
  u16() { this.align(2); const v = this.view.getUint16(this.offset, this.littleEndian); this.offset += 2; return v; }
  i32() { this.align(4); const v = this.view.getInt32(this.offset, this.littleEndian); this.offset += 4; return v; }
  u32() { this.align(4); const v = this.view.getUint32(this.offset, this.littleEndian); this.offset += 4; return v; }
  f32() { this.align(4); const v = this.view.getFloat32(this.offset, this.littleEndian); this.offset += 4; return v; }
  f64() { this.align(8); const v = this.view.getFloat64(this.offset, this.littleEndian); this.offset += 8; return v; }
  string() {
    const length = this.u32();
    if (!length) return '';
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, length - 1);
    this.offset += length;
    return new TextDecoder().decode(bytes);
  }
  sequence(readItem) {
    const length = this.u32();
    if (length > 2_000_000) throw new Error(`Invalid CDR sequence length: ${length}`);
    return Array.from({ length }, () => readItem.call(this));
  }
  header() { return { stamp: { sec: this.i32(), nanosec: this.u32() }, frame_id: this.string() }; }
  vector3() { return { x: this.f64(), y: this.f64(), z: this.f64() }; }
  quaternion() { return { x: this.f64(), y: this.f64(), z: this.f64(), w: this.f64() }; }
  pose() { return { position: this.vector3(), orientation: this.quaternion() }; }
  twist() { return { linear: this.vector3(), angular: this.vector3() }; }
  color() { return { r: this.f32(), g: this.f32(), b: this.f32(), a: this.f32() }; }
  point() { return this.vector3(); }
  marker() {
    const header = this.header();
    const ns = this.string();
    const id = this.i32();
    const type = this.i32();
    const action = this.i32();
    const pose = this.pose();
    const scale = this.vector3();
    const color = this.color();
    const lifetime = { sec: this.i32(), nanosec: this.u32() };
    const frame_locked = this.bool();
    const points = this.sequence(this.point);
    const colors = this.sequence(this.color);
    const text = this.string();
    const mesh_resource = this.string();
    const mesh_use_embedded_materials = this.bool();
    return { header, ns, id, type, action, pose, scale, color, lifetime, frame_locked, points, colors, text, mesh_resource, mesh_use_embedded_materials };
  }
}

function decode(reader, type) {
  switch (type) {
    case 'sensor_msgs/msg/LaserScan':
      return {
        header: reader.header(), angle_min: reader.f32(), angle_max: reader.f32(),
        angle_increment: reader.f32(), time_increment: reader.f32(), scan_time: reader.f32(),
        range_min: reader.f32(), range_max: reader.f32(), ranges: reader.sequence(reader.f32),
        intensities: reader.sequence(reader.f32)
      };
    case 'sensor_msgs/msg/NavSatFix': {
      const header = reader.header();
      const status = { status: reader.i8(), service: reader.u16() };
      const latitude = reader.f64(), longitude = reader.f64(), altitude = reader.f64();
      const position_covariance = Array.from({ length: 9 }, () => reader.f64());
      return { header, status, latitude, longitude, altitude, position_covariance, position_covariance_type: reader.u8() };
    }
    case 'nav_msgs/msg/Odometry': {
      const header = reader.header(), child_frame_id = reader.string();
      const pose = { pose: reader.pose(), covariance: Array.from({ length: 36 }, () => reader.f64()) };
      const twist = { twist: reader.twist(), covariance: Array.from({ length: 36 }, () => reader.f64()) };
      return { header, child_frame_id, pose, twist };
    }
    case 'sensor_msgs/msg/Imu': {
      const header = reader.header();
      const orientation = reader.quaternion();
      const orientation_covariance = Array.from({ length: 9 }, () => reader.f64());
      const angular_velocity = reader.vector3();
      const angular_velocity_covariance = Array.from({ length: 9 }, () => reader.f64());
      const linear_acceleration = reader.vector3();
      const linear_acceleration_covariance = Array.from({ length: 9 }, () => reader.f64());
      return { header, orientation, orientation_covariance, angular_velocity, angular_velocity_covariance, linear_acceleration, linear_acceleration_covariance };
    }
    case 'sensor_msgs/msg/JointState':
      return {
        header: reader.header(), name: reader.sequence(reader.string),
        position: reader.sequence(reader.f64), velocity: reader.sequence(reader.f64), effort: reader.sequence(reader.f64)
      };
    case 'std_msgs/msg/Float32': return { data: reader.f32() };
    case 'std_msgs/msg/Float32MultiArray': {
      const dims = reader.sequence(function readDim() { return { label: this.string(), size: this.u32(), stride: this.u32() }; });
      const data_offset = reader.u32();
      return { layout: { dim: dims, data_offset }, data: reader.sequence(reader.f32) };
    }
    case 'std_msgs/msg/Int16': return { data: reader.i16() };
    case 'std_msgs/msg/Int32': return { data: reader.i32() };
    case 'std_msgs/msg/Bool': return { data: reader.bool() };
    case 'std_msgs/msg/String': return { data: reader.string() };
    case 'geometry_msgs/msg/Twist': return reader.twist();
    case 'visualization_msgs/msg/MarkerArray': return { markers: reader.sequence(reader.marker) };
    default: return undefined;
  }
}

export function decodeRosMessage(buffer, type) {
  if (buffer.byteLength < 4) throw new Error('CDR payload is shorter than its header');
  const encapsulation = new DataView(buffer).getUint8(1);
  if (encapsulation !== 0 && encapsulation !== 1) throw new Error(`Unsupported CDR endianness marker: ${encapsulation}`);
  return decode(new CdrReader(buffer), type);
}
