firewall_ports_apply() {
  ports=$1
  [ "$(kv_get firewall_enabled)" = true ] || return 0
  [ "$TSUB_TIER" != tiny ] || { add_degraded_reason "tiny 档已跳过端口放行规则"; return 0; }
  [ "$TSUB_HAS_NET_ADMIN" = true ] || { add_degraded_reason "缺少 CAP_NET_ADMIN，已跳过端口放行规则"; return 0; }
  [ "$(id -u)" -eq 0 ] || { add_degraded_reason "无特权模式，已跳过端口放行规则"; return 0; }
  if have nft; then
    nft delete table inet tsub >/dev/null 2>&1 || true
    nft add table inet tsub
    nft 'add chain inet tsub input { type filter hook input priority 0; policy accept; }'
    old_ifs=$IFS; IFS=,
    for spec in $ports; do
      protocol=${spec#*/}; number=${spec%/*}
      nft add rule inet tsub input "$protocol" dport "$number" accept
    done
    IFS=$old_ifs
    printf '%s\n' nft >"$TSUB_STATE/firewall.backend"
  elif have iptables; then
    iptables -N TSUB_IN 2>/dev/null || true
    iptables -C INPUT -j TSUB_IN 2>/dev/null || iptables -I INPUT -j TSUB_IN
    iptables -F TSUB_IN
    old_ifs=$IFS; IFS=,
    for spec in $ports; do
      protocol=${spec#*/}; number=${spec%/*}
      iptables -A TSUB_IN -p "$protocol" --dport "$number" -j ACCEPT
    done
    IFS=$old_ifs
    printf '%s\n' iptables >"$TSUB_STATE/firewall.backend"
  else
    add_degraded_reason "未找到 nftables/iptables，已跳过端口放行规则"
    return 0
  fi
  printf '%s\n' "$ports" >"$TSUB_STATE/firewall.ports"
}

firewall_hops_remove() {
  backend=$(cat "$TSUB_STATE/firewall.hops.backend" 2>/dev/null || true)
  if [ "$backend" = nft ]; then
    nft delete table ip tsub_hop >/dev/null 2>&1 || true
    nft delete table ip6 tsub_hop >/dev/null 2>&1 || true
  elif [ "$backend" = iptables ]; then
    for command in iptables ip6tables; do
      have "$command" || continue
      "$command" -t nat -D PREROUTING -j TSUB_HOP >/dev/null 2>&1 || true
      "$command" -t nat -F TSUB_HOP >/dev/null 2>&1 || true
      "$command" -t nat -X TSUB_HOP >/dev/null 2>&1 || true
    done
  fi
  rm -f "$TSUB_STATE/firewall.hops.backend" "$TSUB_STATE/firewall.hops.rules"
}

firewall_hops_apply() {
  rules=$1
  firewall_hops_remove
  [ -n "$rules" ] || return 0
  [ "$TSUB_HAS_NET_ADMIN" = true ] && [ "$(id -u)" -eq 0 ] || return 1
  if have nft; then
    for family in ip ip6; do
      nft add table "$family" tsub_hop || return 1
      nft "add chain $family tsub_hop prerouting { type nat hook prerouting priority dstnat; policy accept; }" || return 1
    done
    for spec in $rules; do
      target=${spec%%:*}; ranges=${spec#*:}; old_ifs=$IFS; IFS=+
      for range in $ranges; do
        nft add rule ip tsub_hop prerouting udp dport "$range" redirect to ":$target" || { IFS=$old_ifs; return 1; }
        nft add rule ip6 tsub_hop prerouting udp dport "$range" redirect to ":$target" || true
        nft add rule inet tsub input udp dport "$range" accept 2>/dev/null || true
      done
      IFS=$old_ifs
    done
    printf '%s\n' nft >"$TSUB_STATE/firewall.hops.backend"
  elif have iptables; then
    for command in iptables ip6tables; do
      have "$command" || continue
      "$command" -t nat -N TSUB_HOP 2>/dev/null || true
      "$command" -t nat -C PREROUTING -j TSUB_HOP 2>/dev/null || "$command" -t nat -I PREROUTING -j TSUB_HOP
      "$command" -t nat -F TSUB_HOP
    done
    for spec in $rules; do
      target=${spec%%:*}; ranges=${spec#*:}; old_ifs=$IFS; IFS=+
      for range in $ranges; do
        start=${range%-*}; end=${range#*-}; [ "$start" = "$end" ] && match=$start || match=$start:$end
        iptables -t nat -A TSUB_HOP -p udp --dport "$match" -j REDIRECT --to-ports "$target" || { IFS=$old_ifs; return 1; }
        have ip6tables && ip6tables -t nat -A TSUB_HOP -p udp --dport "$match" -j REDIRECT --to-ports "$target" || true
        iptables -A TSUB_IN -p udp --dport "$match" -j ACCEPT 2>/dev/null || true
        have ip6tables && ip6tables -A TSUB_IN -p udp --dport "$match" -j ACCEPT 2>/dev/null || true
      done
      IFS=$old_ifs
    done
    printf '%s\n' iptables >"$TSUB_STATE/firewall.hops.backend"
  else
    return 1
  fi
  printf '%s\n' "$rules" >"$TSUB_STATE/firewall.hops.rules"
}

firewall_snapshot() {
  if [ -r "$TSUB_STATE/firewall.ports" ]; then cp "$TSUB_STATE/firewall.ports" "$TSUB_TX/firewall.ports"
  else : >"$TSUB_TX/firewall.ports"; fi
  if [ -r "$TSUB_STATE/firewall.hops.rules" ]; then cp "$TSUB_STATE/firewall.hops.rules" "$TSUB_TX/firewall.hops.rules"
  else : >"$TSUB_TX/firewall.hops.rules"; fi
}

firewall_restore() {
  [ -f "$TSUB_TX/firewall.ports" ] || return 0
  old_ports=$(cat "$TSUB_TX/firewall.ports")
  if [ -n "$old_ports" ]; then firewall_ports_apply "$old_ports"
  else
    backend=$(cat "$TSUB_STATE/firewall.backend" 2>/dev/null || true)
    [ "$backend" = nft ] && nft delete table inet tsub >/dev/null 2>&1 || true
    if [ "$backend" = iptables ]; then
      iptables -D INPUT -j TSUB_IN >/dev/null 2>&1 || true
      iptables -F TSUB_IN >/dev/null 2>&1 || true
      iptables -X TSUB_IN >/dev/null 2>&1 || true
    fi
    rm -f "$TSUB_STATE/firewall.backend" "$TSUB_STATE/firewall.ports"
  fi
  old_hops=$(cat "$TSUB_TX/firewall.hops.rules" 2>/dev/null || true)
  firewall_hops_apply "$old_hops" || true
}

firewall_remove() {
  firewall_hops_remove
  backend=$(cat "$TSUB_STATE/firewall.backend" 2>/dev/null || true)
  [ "$backend" = nft ] && nft delete table inet tsub >/dev/null 2>&1 || true
  if [ "$backend" = iptables ]; then
    iptables -D INPUT -j TSUB_IN >/dev/null 2>&1 || true
    iptables -F TSUB_IN >/dev/null 2>&1 || true
    iptables -X TSUB_IN >/dev/null 2>&1 || true
  fi
  rm -f "$TSUB_STATE/firewall.backend" "$TSUB_STATE/firewall.ports"
}
