#!/bin/sh
# LXDOC 恢复脚本
# 用法：在 backup 容器内执行
#   ./restore.sh list                          列出可用备份
#   ./restore.sh db  <备份日期> [db_file]       恢复数据库
#   ./restore.sh uploads <备份日期> [file]      恢复 uploads
#   ./restore.sh all <备份日期>                 恢复数据库+uploads
# 警告：恢复会覆盖现有数据，请先确认！
set -eu

DB_HOST="${DB_HOST:-postgres}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-lxdoc}"
DB_PASS="${DB_PASS:-lxdoc}"
DB_NAME="${DB_NAME:-lxdoc}"
UPLOADS_DIR="${UPLOADS_DIR:-/app/uploads}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
export PGPASSWORD="${DB_PASS}"

ACTION="${1:-list}"

list_backups() {
  echo "可用备份（按日期目录）："
  echo "================================"
  if [ ! -d "${BACKUP_DIR}" ] || [ -z "$(ls -A "${BACKUP_DIR}" 2>/dev/null)" ]; then
    echo "  （无备份）"
    return
  fi
  for dir in "${BACKUP_DIR}"/*/; do
    [ -d "${dir}" ] || continue
    day=$(basename "${dir}")
    echo "  ${day}/"
    ls -lh "${dir}" 2>/dev/null | grep -v '^total' | grep -v '^d' | while read line; do
      echo "    ${line}"
    done
  done
}

restore_db() {
  day="$1"
  db_file="${2:-}"
  dir="${BACKUP_DIR}/${day}"
  if [ ! -d "${dir}" ]; then
    echo "错误：备份 ${day} 不存在"
    exit 1
  fi
  # 未指定文件时取目录下第一个 db_*.dump
  if [ -z "${db_file}" ]; then
    db_file=$(ls "${dir}"/db_*.dump 2>/dev/null | head -1)
    if [ -z "${db_file}" ]; then
      echo "错误：${day} 下无数据库备份文件"
      exit 1
    fi
  elif [ ! -f "${db_file}" ]; then
    # 尝试拼接路径
    db_file="${dir}/${db_file}"
  fi
  echo "警告：即将从 ${db_file} 恢复数据库，将覆盖现有数据！"
  printf "确认继续？[输入 YES 确认]: "
  read confirm
  [ "${confirm}" = "YES" ] || { echo "已取消"; exit 0; }

  echo "→ 恢复数据库..."
  # pg_restore --clean 先删后建，--if-exists 避免不存在报错
  pg_restore \
    -h "${DB_HOST}" \
    -p "${DB_PORT}" \
    -U "${DB_USER}" \
    -d "${DB_NAME}" \
    --clean --if-exists --no-owner --no-privileges \
    "${db_file}"
  echo "✓ 数据库恢复完成"
}

restore_uploads() {
  day="$1"
  file="${2:-}"
  dir="${BACKUP_DIR}/${day}"
  if [ ! -d "${dir}" ]; then
    echo "错误：备份 ${day} 不存在"
    exit 1
  fi
  if [ -z "${file}" ]; then
    file=$(ls "${dir}"/uploads_*.tar.gz 2>/dev/null | head -1)
    if [ -z "${file}" ]; then
      echo "错误：${day} 下无 uploads 备份文件"
      exit 1
    fi
  elif [ ! -f "${file}" ]; then
    file="${dir}/${file}"
  fi
  echo "警告：即将从 ${file} 恢复 uploads，将覆盖现有文件！"
  printf "确认继续？[输入 YES 确认]: "
  read confirm
  [ "${confirm}" = "YES" ] || { echo "已取消"; exit 0; }

  mkdir -p "$(dirname "${UPLOADS_DIR}")"
  echo "→ 恢复 uploads..."
  tar -xzf "${file}" -C "$(dirname "${UPLOADS_DIR}")"
  echo "✓ uploads 恢复完成: ${UPLOADS_DIR}"
}

case "${ACTION}" in
  list)
    list_backups
    ;;
  db)
    [ -z "$2" ] && { echo "用法: $0 db <备份日期> [db_file]"; exit 1; }
    restore_db "$2" "$3"
    ;;
  uploads)
    [ -z "$2" ] && { echo "用法: $0 uploads <备份日期> [file]"; exit 1; }
    restore_uploads "$2" "$3"
    ;;
  all)
    [ -z "$2" ] && { echo "用法: $0 all <备份日期>"; exit 1; }
    restore_db "$2" ""
    restore_uploads "$2" ""
    ;;
  *)
    echo "用法: $0 {list|db|uploads|all} [参数...]"
    exit 1
    ;;
esac
