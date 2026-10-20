#!/bin/bash
# screenctl 特权助手：由 sudoers 白名单授权，仅接受以下固定动作
# 用法：sudo -n priv-helper.sh <screen-on|screen-off|lid-on|lid-off|reboot>

CONF="${SCREENCTL_CONF:-/etc/systemd/logind.conf}"
BACKUP="${CONF}.screenctl.bak"
LID_KEYS="HandleLidSwitch HandleLidSwitchExternalPower HandleLidSwitchDocked"

log() { echo "$(date '+%F %T') $*" >> "${TRIM_PKGVAR:-/tmp}/priv.log" 2>/dev/null || true; }

restart_logind() {
  systemctl restart systemd-logind 2>/dev/null || systemctl try-restart systemd-logind 2>/dev/null || true
}

case "$1" in
  screen-on)
    [ -e /dev/tty1 ] || { echo "/dev/tty1 不存在"; exit 1; }
    setterm --blank poke --term linux </dev/tty1
    ;;
  screen-off)
    [ -e /dev/tty1 ] || { echo "/dev/tty1 不存在"; exit 1; }
    setterm --blank force --term linux </dev/tty1
    ;;
  lid-on)
    # 首次修改前备份原文件（记住默认状态），再把三个合盖键改为未注释的 ignore
    [ -f "$BACKUP" ] || cp -p "$CONF" "$BACKUP" 2>/dev/null || true
    for k in $LID_KEYS; do
      if grep -qE "^#?[[:space:]]*${k}=" "$CONF"; then
        sed -i -E "s/^#?[[:space:]]*${k}=.*$/${k}=ignore/" "$CONF"
      else
        sed -i "/^\[Login\]/a ${k}=ignore" "$CONF"
      fi
    done
    restart_logind
    ;;
  lid-off)
    # 还原默认：优先用备份恢复，再兜底把 ignore 行注释掉
    if [ -f "$BACKUP" ]; then
      cp -p "$BACKUP" "$CONF"
    fi
    for k in $LID_KEYS; do
      sed -i -E "s/^${k}=ignore/#${k}=ignore/" "$CONF"
    done
    restart_logind
    ;;
  reboot)
    systemctl reboot -i
    ;;
  *)
    echo "unknown action: $1"
    exit 1
    ;;
esac

log "action=$1 ok"
exit 0
