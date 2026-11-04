UPDATE data_backup_exports
SET suggested_file_name = '旺崽数据备份-' || substr(package_sha256, 1, 12) || '.wzb';

PRAGMA user_version = 66;
