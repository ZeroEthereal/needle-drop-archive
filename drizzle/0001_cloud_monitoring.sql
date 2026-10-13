INSERT INTO monitored_playlists
  (id, name, owner_uid, owner_name, owned, list_order, baseline_established, bound_at)
SELECT 'netease-cloud', '网易云盘', account_uid, COALESCE(account_nickname, '网易云用户'),
  1, 2147483647, 0, COALESCE(bound_at, CURRENT_TIMESTAMP)
FROM instance_config WHERE id = 'primary' AND account_uid IS NOT NULL AND status = 'ready'
ON CONFLICT(id) DO NOTHING;
