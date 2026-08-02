#!/bin/sh
# LXDOC 备份脚本
# 功能：pg_dump 数据库 + tar 打包 uploads 目录，按日期归档到 /backups
# 由 backup 容器内 cron 调用，也可手动执行
set -eu

# 从环境变量读取配置（带默认值）
DB_HOST="${DB_HOST:-postgres}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-lxdoc}"
DB_PASS="${DB_PASS:-lxdoc}"
DB_NAME="${DB_NAME:-lxdoc}"
UPLOADS_DIR="${UPLOADS_DIR:-/app/uploads}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"

# 日期标记
DATE=$(date +%Y%m%d_%H%M%S)
DATE_DAY=$(date +%Y%m%d)
TARGET_DIR="${BACKUP_DIR}/${DATE_DAY}"
mkdir -p "${TARGET_DIR}"

echo "[$(date '+%F %T')] 开始备份 → ${TARGET_DIR}"

# 导出数据库（自定义格式，支持选择性恢复，压缩）
export PGPASSWORD="${DB_PASS}"
DB_FILE="${TARGET_DIR}/db_${DATE}.dump"
echo "  → pg_dump 数据库..."
pg_dump \
  -h "${DB_HOST}" \
  -p "${DB_PORT}" \
  -U "${DB_USER}" \
  -d "${DB_NAME}" \
  -F c \
  -Z 6 \
  --no-owner --no-privileges \
  -f "${DB_FILE}"

DB_SIZE=$(du -sh "${DB_FILE}" | cut -f1)
echo "  ✓ 数据库备份完成 (${DB_SIZE}): ${DB_FILE}"

# 打包 uploads 目录（若有内容）
if [ -d "${UPLOADS_DIR}" ] && [ "$(ls -A "${UPLOADS_DIR}" 2>/dev/null)" ]; then
  UPLOADS_FILE="${TARGET_DIR}/uploads_${DATE}.tar.gz"
  echo "  → tar 打包 uploads..."
  # H9: --no-unquote 关闭文件名反引号转义解析，避免 UPLOADS_DIR 注入风险
  tar --no-unquote -czf "${UPLOADS_FILE}" -C "$(dirname "${UPLOADS_DIR}")" "$(basename "${UPLOADS_DIR}")"
  UPLOADS_SIZE=$(du -sh "${UPLOADS_FILE}" | cut -f1)
  echo "  ✓ uploads 备份完成 (${UPLOADS_SIZE}): ${UPLOADS_FILE}"
else
  echo "  - uploads 目录为空或不存在，跳过"
fi

# 清理过期备份
echo "  → 清理 ${RETENTION_DAYS} 天前的备份..."
DELETED=0
find "${BACKUP_DIR}" -mindepth 1 -maxdepth 1 -type d -mtime "+${RETENTION_DAYS}" | while read dir; do
  echo "    删除过期备份: $(basename "${dir}")"
  rm -rf "${dir}"
done

# 同目录下孤立的文件也清理
find "${BACKUP_DIR}" -mindepth 2 -maxdepth 2 -type f -mtime "+${RETENTION_DAYS}" -delete 2>/dev/null || true

echo "[$(date '+%F %T')] 备份完成"
echo "----------------------------------------"
