-- 0001_pub_date_to_millis.sql
--
-- 背景（C1）：旧版 Worker 把 pub_date 写成 ISO 字符串（'2024-01-05T06:07:08.000Z'），
-- 而 Node/Go 写毫秒整数（1712345678901）。三端现已统一为毫秒整数，
-- 三端启动时的自迁移也会自动归一化历史数据（见 README.md）。
-- 本脚本是三端自迁移的等价手工版本，适用于：
--   * 不希望应用启动时写库（只读挂载、权限受限）的部署；
--   * 需要在升级前先把数据修好，再切换新版本。
--
-- 幂等：只处理 typeof(pub_date) = 'text' 的行，重复执行不会改变结果。
-- 执行前请备份。

UPDATE Comment
   SET pub_date = CASE
       -- 纯数字字符串（'1712345678901'）
       WHEN pub_date NOT GLOB '*[^0-9]*' AND CAST(pub_date AS INTEGER) > 0
         THEN CAST(pub_date AS INTEGER)
       -- ISO 字符串 / 'YYYY-MM-DD'（按 UTC 解析，与 strftime(...,'unixepoch') 一致）
       WHEN CAST(strftime('%s', pub_date) AS INTEGER) > 0
         THEN CAST(strftime('%s', pub_date) AS INTEGER) * 1000
       -- 无法解析的脏数据保持原样，便于事后人工排查
       ELSE pub_date
     END
 WHERE typeof(pub_date) = 'text';

-- 校验：以下查询应返回 0 行（空串等无法解析的值除外）
-- SELECT COUNT(*) FROM Comment
--  WHERE typeof(pub_date) = 'text' AND CAST(strftime('%s', pub_date) AS INTEGER) > 0;
