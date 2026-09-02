CREATE DATABASE IF NOT EXISTS flow_logs;

CREATE TABLE IF NOT EXISTS flow_logs.user_flow_logs
(
  ts              DateTime DEFAULT now(),
  username        String,
  src_ip          IPv4,
  dst_ip          IPv4,
  dst_port        UInt16,
  proto           UInt8,
  bytes           UInt64,
  packets         UInt64,
  router_id       String DEFAULT '',
  session_id      String DEFAULT ''
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (username, ts, dst_ip, dst_port)
TTL ts + INTERVAL 30 DAY
SETTINGS index_granularity = 8192, max_suspicious_broken_parts = 10000;

