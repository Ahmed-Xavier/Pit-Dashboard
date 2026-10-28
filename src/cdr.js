// Minimal ROS 2 CDR reader for message types published by Autonomous-outdoor-RC.
// Foxglove's binary message frame contains the CDR payload including its 4-byte
// encapsulation header.
//
// Fix Group 2 fast paths:
//  - readF32Array(n): returns Float32Array from a typed view (zero-copy when aligned)
//  - readF64Array(n): returns Float64Array for covariance blocks
//  - Shared TextDecoder instance

const _textDecoder = new TextDecoder();
const MAX_SEQUENCE_LENGTH = 20_000;

/** Encode geometry_msgs/PointStamped in ROS 2 little-endian CDR. */
export function encodePointStamped(point, frameId = 'map', date = new Date()) {
  const encoder = new TextEncoder();
  const frame = encoder.encode(`${frameId}\0`);
  const body = new ArrayBuffer(4 + 4 + 4 + frame.length + 4 + 24);
  const view = new DataView(body);
  let offset = 4;
  const align = (size) => { offset = 4 + Math.ceil((offset - 4) / size) * size; };
  const writeU32 = (value) => { align(4); view.setUint32(offset, value, true); offset += 4; };
  const writeI32 = (value) => { align(4); view.setInt32(offset, value, true); offset += 4; };
  // CDR encapsulation: little-endian, plain CDR.
  view.setUint8(0, 0); view.setUint8(1, 1);
  const millis = date.getTime();
  writeI32(Math.floor(millis / 1000));
  writeU32((millis % 1000) * 1_000_000);
  writeU32(frame.length);
  new Uint8Array(body, offset, frame.length).set(frame); offset += frame.length;
  for (const value of [point.x, point.y, point.z ?? 0]) {
    align(8); view.setFloat64(offset, value, true); offset += 8;
  }
  return new Uint8Array(body, 0, offset);
}

class CdrReader {
  constructor(buffer) {
    this.buf = buffer;
    this.view = new DataView(buffer);
    this.littleEndian = this.view.getUint8(1) === 1;
    this.offset = 4;
  }

  // The 4-byte CDR encapsulation header is outside the serialized body. CDR
  // member alignment is relative to the body start, not the start of the frame.
  align(size) { this.offset = 4 + Math.ceil((this.offset - 4) / size) * size; }
  i8()  { return this.view.getInt8(this.offset++); }
  u8()  { return this.view.getUint8(this.offset++); }
  bool() { return this.u8() !== 0; }
  length() {
    const length = this.u32();
    if (length > MAX_SEQUENCE_LENGTH) throw new Error(`Invalid CDR sequence length: ${length}`);
    return length;
  }
  i16() { this.align(2); const v = this.view.getInt16(this.offset, this.littleEndian); this.offset += 2; return v; }
  u16() { this.align(2); const v = this.view.getUint16(this.offset, this.littleEndian); this.offset += 2; return v; }
  i32() { this.align(4); const v = this.view.getInt32(this.offset, this.littleEndian); this.offset += 4; return v; }
  u32() { this.align(4); const v = this.view.getUint32(this.offset, this.littleEndian); this.offset += 4; return v; }
  i64() { this.align(8); const v = this.view.getBigInt64(this.offset, this.littleEndian); this.offset += 8; return v; }
  f32() { this.align(4); const v = this.view.getFloat32(this.offset, this.littleEndian); this.offset += 4; return v; }
  f64() { this.align(8); const v = this.view.getFloat64(this.offset, this.littleEndian); this.offset += 8; return v; }

  string() {
    const length = this.u32();
    if (!length) return '';
    const bytes = new Uint8Array(this.buf, this.view.byteOffset + this.offset, length - 1);
    this.offset += length;
    return _textDecoder.decode(bytes);
  }

  /**
   * Fast path: read n × float32 as a Float32Array.
   * Uses a typed view when the buffer is already aligned; copies otherwise.
   * On little-endian x86/ARM (all common browsers) this is zero-copy.
   */
  readF32Array(n) {
    this.align(4);
    const byteOffset = this.view.byteOffset + this.offset;
    this.offset += n * 4;
    if (byteOffset % 4 === 0) {
      return new Float32Array(this.buf, byteOffset, n);
    }
    // Misaligned: must copy
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = this.view.getFloat32(byteOffset - this.view.byteOffset + i * 4, this.littleEndian);
    }
    return out;
  }

  /**
   * Fast path: read n × float64 as a Float64Array.
   */
  readF64Array(n) {
    this.align(8);
    const byteOffset = this.view.byteOffset + this.offset;
    this.offset += n * 8;
    if (byteOffset % 8 === 0) {
      return new Float64Array(this.buf, byteOffset, n);
    }
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = this.view.getFloat64(byteOffset - this.view.byteOffset + i * 8, this.littleEndian);
    }
    return out;
  }

  sequenceU8() { return Uint8Array.from(this.sequence(this.u8)); }
  sequenceBool() { return this.sequence(this.bool); }
  sequenceI64() { return this.sequence(this.i64); }
  sequenceF64() { return this.readF64Array(this.u32()); }

  sequence(readItem) {
    const length = this.length();
    const values = new Array(length);
    for (let i = 0; i < length; i++) values[i] = readItem.call(this);
    return values;
  }

  pointSequence() {
    const length = this.length();
    const values = new Float64Array(length * 3);
    for (let i = 0; i < values.length; i++) values[i] = this.f64();
    return values;
  }

  header()      { return { stamp: { sec: this.i32(), nanosec: this.u32() }, frame_id: this.string() }; }
  vector3()     { return { x: this.f64(), y: this.f64(), z: this.f64() }; }
  quaternion()  { return { x: this.f64(), y: this.f64(), z: this.f64(), w: this.f64() }; }
  pose()        { return { position: this.vector3(), orientation: this.quaternion() }; }
  poseWithCovariance() { return { pose: this.pose(), covariance: this.readF64Array(36) }; }
  twist()       { return { linear: this.vector3(), angular: this.vector3() }; }
  color()       { return { r: this.f32(), g: this.f32(), b: this.f32(), a: this.f32() }; }
  point()       { return this.vector3(); }
  compressedImage() {
    return { header: this.header(), format: this.string(), data: this.sequenceU8() };
  }
  image() {
    const header = this.header();
    const height = this.u32();
    const width = this.u32();
    const encoding = this.string();
    const is_bigendian = this.u8();
    const step = this.u32();
    const length = this.u32();
    if (length > 16_000_000) throw new Error(`Image data is too large: ${length} bytes`);
    const data = new Uint8Array(this.buf, this.view.byteOffset + this.offset, length);
    this.offset += length;
    return { header, height, width, encoding, is_bigendian, step, data };
  }
  uvCoordinate() { return { u: this.f32(), v: this.f32() }; }
  meshFile() { return { filename: this.string(), data: this.sequenceU8() }; }

  marker() {
    const header   = this.header();
    const ns       = this.string();
    const id       = this.i32();
    const type     = this.i32();
    const action   = this.i32();
    const pose     = this.pose();
    const scale    = this.vector3();
    const color    = this.color();
    const lifetime = { sec: this.i32(), nanosec: this.u32() };
    const frame_locked = this.bool();
    // MarkerArray point sets can contain thousands of points (planner arcs).
    // A flat typed array avoids one JS object allocation per point.
    const points   = this.pointSequence();
    const colors   = this.sequence(this.color);
    const texture_resource = this.string();
    const texture = this.compressedImage();
    const uv_coordinates = this.sequence(this.uvCoordinate);
    const text     = this.string();
    const mesh_resource = this.string();
    const mesh_file = this.meshFile();
    const mesh_use_embedded_materials = this.bool();
    return { header, ns, id, type, action, pose, scale, color, lifetime,
             frame_locked, points, colors, texture_resource, texture, uv_coordinates, text,
             mesh_resource, mesh_file, mesh_use_embedded_materials };
  }

  diagnosticStatus() {
    return { level: this.i8(), name: this.string(), message: this.string(), hardware_id: this.string(),
      values: this.sequence(function readKeyValue() { return { key: this.string(), value: this.string() }; }) };
  }

  parameterValue() {
    return { type: this.u8(), bool_value: this.bool(), integer_value: this.i64(), double_value: this.f64(),
      string_value: this.string(), byte_array_value: this.sequenceU8(), bool_array_value: this.sequenceBool(),
      integer_array_value: this.sequenceI64(), double_array_value: this.sequenceF64(),
      string_array_value: this.sequence(this.string) };
  }

  parameter() { return { name: this.string(), value: this.parameterValue() }; }

  transform() {
    return { translation: this.vector3(), rotation: this.quaternion() };
  }

  transformStamped() {
    return {
      header: this.header(),
      child_frame_id: this.string(),
      transform: this.transform()
    };
  }
}

function decode(reader, type) {
  switch (type) {
    case 'sensor_msgs/msg/LaserScan': {
      const header        = reader.header();
      const angle_min     = reader.f32();
      const angle_max     = reader.f32();
      const angle_increment = reader.f32();
      const time_increment  = reader.f32();
      const scan_time     = reader.f32();
      const range_min     = reader.f32();
      const range_max     = reader.f32();
      // Fast path: read length-prefixed float32 sequences via typed array views
      const rangesLen     = reader.length();
      const ranges        = reader.readF32Array(rangesLen);
      const intensitiesLen = reader.length();
      const intensities   = reader.readF32Array(intensitiesLen);
      return { header, angle_min, angle_max, angle_increment, time_increment,
               scan_time, range_min, range_max, ranges, intensities };
    }

    case 'sensor_msgs/msg/NavSatFix': {
      const header   = reader.header();
      const status   = { status: reader.i8(), service: reader.u16() };
      const latitude = reader.f64(), longitude = reader.f64(), altitude = reader.f64();
      // position_covariance (9×f64) — skipped by consumer but must advance offset
      const position_covariance = reader.readF64Array(9);
      return { header, status, latitude, longitude, altitude,
               position_covariance, position_covariance_type: reader.u8() };
    }

    case 'nav_msgs/msg/Odometry': {
      const header         = reader.header();
      const child_frame_id = reader.string();
      // pose: geometry_msgs/PoseWithCovariance (pose + 36×f64 covariance)
      const poseVal   = reader.poseWithCovariance();
      // twist: geometry_msgs/TwistWithCovariance (twist + 36×f64 covariance)
      const twistVal  = { twist: reader.twist(), covariance: reader.readF64Array(36) };
      return {
        header, child_frame_id,
        pose: poseVal,
        twist: twistVal
      };
    }

    case 'sensor_msgs/msg/Imu': {
      const header      = reader.header();
      const orientation = reader.quaternion();
      const orientation_covariance = reader.readF64Array(9);
      const angular_velocity = reader.vector3();
      const angular_velocity_covariance = reader.readF64Array(9);
      const linear_acceleration = reader.vector3();
      const linear_acceleration_covariance = reader.readF64Array(9);
      return { header, orientation, orientation_covariance, angular_velocity, angular_velocity_covariance,
        linear_acceleration, linear_acceleration_covariance };
    }

    case 'sensor_msgs/msg/Image':
      return reader.image();

    case 'sensor_msgs/msg/JointState':
      return {
        header:   reader.header(),
        name:     reader.sequence(reader.string),
        position: reader.sequence(reader.f64),
        velocity: reader.sequence(reader.f64),
        effort:   reader.sequence(reader.f64)
      };

    case 'std_msgs/msg/Float32':           return { data: reader.f32() };
    case 'std_msgs/msg/Float64':           return { data: reader.f64() };
    case 'std_msgs/msg/Float32MultiArray': {
      const dims = reader.sequence(function readDim() {
        return { label: this.string(), size: this.u32(), stride: this.u32() };
      });
      const data_offset = reader.u32();
      const dataLen = reader.length();
      const data = reader.readF32Array(dataLen);
      return { layout: { dim: dims, data_offset }, data };
    }
    case 'std_msgs/msg/Int16':  return { data: reader.i16() };
    case 'std_msgs/msg/Int32':  return { data: reader.i32() };
    case 'std_msgs/msg/Bool':   return { data: reader.bool() };
    case 'std_msgs/msg/String': return { data: reader.string() };
    case 'geometry_msgs/msg/Twist':                return reader.twist();
    case 'geometry_msgs/msg/PointStamped':
      return { header: reader.header(), point: reader.point() };
    case 'geometry_msgs/msg/PoseStamped':
      return { header: reader.header(), pose: reader.pose() };
    case 'geometry_msgs/msg/PoseWithCovarianceStamped':
      return { header: reader.header(), pose: reader.poseWithCovariance() };
    case 'visualization_msgs/msg/MarkerArray':     return { markers: reader.sequence(reader.marker) };
    case 'geometry_msgs/msg/TransformStamped':     return reader.transformStamped();
    case 'tf2_msgs/msg/TFMessage':
      return { transforms: reader.sequence(reader.transformStamped) };
    case 'diagnostic_msgs/msg/DiagnosticArray':
      return { header: reader.header(), status: reader.sequence(reader.diagnosticStatus) };
    case 'rcl_interfaces/msg/Log':
      return { stamp: { sec: reader.i32(), nanosec: reader.u32() }, level: reader.u8(), name: reader.string(),
        msg: reader.string(), file: reader.string(), function: reader.string(), line: reader.u32() };
    case 'rcl_interfaces/msg/ParameterEvent':
      return { stamp: { sec: reader.i32(), nanosec: reader.u32() }, node: reader.string(),
        new_parameters: reader.sequence(reader.parameter), changed_parameters: reader.sequence(reader.parameter),
        deleted_parameters: reader.sequence(reader.parameter) };
    case 'rosgraph_msgs/msg/Clock':
      return { clock: { sec: reader.i32(), nanosec: reader.u32() } };
    default: return undefined;
  }
}

export function decodeRosMessage(buffer, type) {
  if (type === 'foxglove.SystemInfo') return JSON.parse(_textDecoder.decode(new Uint8Array(buffer)));
  if (buffer.byteLength < 4) throw new Error('CDR payload is shorter than its header');
  const encapsulation = new DataView(buffer).getUint8(1);
  if (encapsulation !== 0 && encapsulation !== 1)
    throw new Error(`Unsupported CDR endianness marker: ${encapsulation}`);
  return decode(new CdrReader(buffer), type);
}

export function validateDecodedMessage(topic, type, message) {
  if (type === 'tf2_msgs/msg/TFMessage' && message.transforms.length > 256) return `$.transforms has ${message.transforms.length} entries (limit 256)`;
  if (type === 'visualization_msgs/msg/MarkerArray' && message.markers.length > 1024) return `$.markers has ${message.markers.length} entries (limit 1024)`;
  if (type === 'sensor_msgs/msg/Image') {
    if (!message.header?.frame_id) return '$.header.frame_id is empty';
    if (!Number.isInteger(message.width) || !Number.isInteger(message.height) ||
        message.width <= 0 || message.height <= 0 || message.width > 4096 || message.height > 4096) {
      return '$.width/height is outside supported bounds';
    }
    if (!message.encoding || !message.data || message.data.length > 16_000_000) {
      return '$.data is missing or too large';
    }
    return null;
  }
  const stack = [{ value: message, path: '$' }];
  while (stack.length) {
    const { value, path } = stack.pop();
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        // ROS LaserScan uses +Inf for a measurement with no return.
        if (type === 'sensor_msgs/msg/LaserScan' && path.startsWith('$.ranges[') && value === Infinity) continue;
        return `${path} is non-finite`;
      }
      if (/\.(?:position|translation|point|points\[\d+\])\.(?:x|y|z)$/.test(path) && Math.abs(value) > 1e7) {
        return `${path} exceeds 1e7 m`;
      }
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    if (value.x !== undefined && value.y !== undefined && value.z !== undefined && value.w !== undefined &&
        /\.(?:orientation|rotation|quaternion)$/.test(path)) {
      const norm = Math.hypot(value.x, value.y, value.z, value.w);
      if (!Number.isFinite(norm) || Math.abs(norm - 1) > 0.2) return `${path} quaternion norm ${norm} is outside 1 ± 0.2`;
    }
    if (ArrayBuffer.isView(value) || Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i], path: `${path}[${i}]` });
    } else {
      for (const key of Object.keys(value)) stack.push({ value: value[key], path: `${path}.${key}` });
    }
  }

  const requireHeader = type === 'nav_msgs/msg/Odometry' ||
    type === 'sensor_msgs/msg/LaserScan' || type === 'sensor_msgs/msg/Imu' || type === 'sensor_msgs/msg/NavSatFix' ||
    type === 'geometry_msgs/msg/PointStamped' || type === 'geometry_msgs/msg/PoseStamped' ||
    type === 'geometry_msgs/msg/PoseWithCovarianceStamped';
  if (requireHeader && !message.header?.frame_id) return '$.header.frame_id is empty';
  if (type === 'sensor_msgs/msg/LaserScan' && message.ranges.length > 1 && message.angle_increment === 0) return '$.angle_increment is zero';
  if (type === 'sensor_msgs/msg/LaserScan' && message.range_max < message.range_min) return '$.range_max is below range_min';
  if (type === 'nav_msgs/msg/Odometry' && !message.child_frame_id) return '$.child_frame_id is empty';
  if (type === 'tf2_msgs/msg/TFMessage') {
    for (let i = 0; i < message.transforms.length; i++) {
      const transform = message.transforms[i];
      if (!transform.header.frame_id) return `$.transforms[${i}].header.frame_id is empty`;
      if (!transform.child_frame_id) return `$.transforms[${i}].child_frame_id is empty`;
    }
  }
  if (type === 'visualization_msgs/msg/MarkerArray') {
    for (let i = 0; i < message.markers.length; i++) {
      const marker = message.markers[i];
      if (marker.action !== 3 && !marker.header.frame_id) return `$.markers[${i}].header.frame_id is empty`;
    }
  }
  return null;
}
