import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { RUNTIME_MANIFEST } from '../../functions/generated/runtime-manifest.js';
import { RUNTIME_VERSION } from '../../src/constants/deployment-options.js';

describe('generated TSub Proxy v2', () => {
  it('matches the generated manifest and size budget', async () => {
    const source = await readFile('public/proxy/v2/tsub-proxy.sh');
    expect(source.byteLength).toBeLessThanOrEqual(512 * 1024);
    expect(createHash('sha256').update(source).digest('hex')).toBe(RUNTIME_MANIFEST.sha256);
    expect(RUNTIME_VERSION).toBe(RUNTIME_MANIFEST.version);
    expect(source.toString()).toContain(`TSUB_RUNTIME_VERSION='${RUNTIME_VERSION}'`);
    expect(source.toString()).toContain('main "$@"');
  });

  it('skips optional port allow rules when unavailable but keeps HY2 hop NAT mandatory', async () => {
    const plan = await readFile('runtime/v2/modules/20-plan.sh', 'utf8');
    const firewall = await readFile('runtime/v2/modules/35-firewall.sh', 'utf8');
    expect(firewall).toContain('[ "$TSUB_TIER" != tiny ] || { i18n_degraded "tiny 档已跳过端口放行规则"');
    expect(firewall).toContain('[ "$TSUB_HAS_NET_ADMIN" = true ] || { i18n_degraded "缺少 CAP_NET_ADMIN，已跳过端口放行规则"');
    expect(firewall).toContain('i18n_degraded "未找到 nftables/iptables，已跳过端口放行规则"');
    expect(plan).toContain('[ "$TSUB_HAS_NET_ADMIN" = true ] || i18n_die "Hysteria2 端口跳跃需要 CAP_NET_ADMIN"');
    expect(plan).toContain('have nft || have iptables || i18n_die "Hysteria2 端口跳跃需要 nftables 或 iptables"');
    expect(firewall).toContain('firewall_hops_apply()');
  });

  it('serializes mutating runtime actions and releases stale operation locks', async () => {
    const common = await readFile('runtime/v2/modules/00-common.sh', 'utf8');
    const main = await readFile('runtime/v2/modules/90-main.sh', 'utf8');
    expect(common).toContain('apply|update|update-runtime|repair|restart|rollback|uninstall) return 0');
    expect(common).toContain('TSUB_OPERATION_LOCK_WAIT_SECONDS:-1800');
    expect(common).toContain('kill -0 "$runtime_lock_pid"');
    expect(common).toContain('rmdir "$TSUB_OPERATION_LOCK"');
    expect(common).toContain('i18n_die "等待其他 TSub 操作完成超时"');
    expect(common.indexOf('release_runtime_operation_lock')).toBeLessThan(common.indexOf('rm -rf "$TSUB_TMP"'));
    expect(main).toContain('acquire_runtime_operation_lock "$action"');
    expect(main).toContain("trap 'cleanup_runtime' EXIT");
    expect(main).toContain("trap 'exit 130' HUP INT TERM");
  });

  it('supports the dedicated update-version Agent action', async () => {
    const agent = await readFile('runtime/v2/modules/38-agent.sh', 'utf8');
    const main = await readFile('runtime/v2/modules/90-main.sh', 'utf8');
    expect(agent).toContain('apply|update|update-runtime|reinstall');
    expect(agent).toContain('exec /bin/sh "$TSUB_BIN/tsub-proxy.sh" agent');
    expect(main).toContain('update-runtime)');
    expect(main).toContain('Runtime 更新失败，当前版本保持不变');
  });

  it('reports host and cgroup Swap without adding it to available memory', async () => {
    const detect = await readFile('runtime/v2/modules/10-detect.sh', 'utf8');
    const common = await readFile('runtime/v2/modules/00-common.sh', 'utf8');
    const agent = await readFile('runtime/v2/modules/38-agent.sh', 'utf8');
    expect(detect).toContain('memory.swap.current');
    expect(detect).toContain('memory.memsw.usage_in_bytes');
    expect(detect).toContain('TSUB_SWAP_TOTAL_MB');
    expect(detect).not.toMatch(/TSUB_MEMORY_AVAILABLE_BYTES=.*TSUB_SWAP/);
    expect(common).toContain('swapTotalMb=%s');
    expect(common).toContain('cgroupSwapLimitMb=%s');
    expect(agent).toContain('"swapReported":%s');
    expect(agent).toContain('"cgroupSwapReported":%s');
  });

  it('splits label-free sing-box TLS keypair PEM output by block boundaries', async () => {
    const source = await readFile('runtime/v2/modules/33-certificate.sh', 'utf8');
    expect(source).toContain('/BEGIN.*PRIVATE KEY/{capture=1}');
    expect(source).toContain('/BEGIN CERTIFICATE/{capture=1}');
    expect(source).not.toContain('/^PrivateKey:/{capture=1');
  });

  it('does not copy Xray certificate outputs onto the same transaction path', async () => {
    const source = await readFile('runtime/v2/modules/33-certificate.sh', 'utf8');
    expect(source).toContain('[ "$candidate" = "$self_signed_key" ] || cp "$candidate" "$self_signed_key"');
    expect(source).toContain('[ "$candidate" = "$self_signed_cert" ] || cp "$candidate" "$self_signed_cert"');
  });

  it('restores the service identity after certificate preparation before any unchanged fast path', async () => {
    const transaction = await readFile('runtime/v2/modules/50-transaction.sh', 'utf8');
    const certificate = transaction.indexOf('ensure_certificate');
    const identity = transaction.indexOf('prepare_service_identity', certificate);
    const candidateHash = transaction.indexOf('subscription_candidate_hash=', identity);
    expect(certificate).toBeGreaterThanOrEqual(0);
    expect(identity).toBeGreaterThan(certificate);
    expect(candidateHash).toBeGreaterThan(identity);
  });

  it('waits for the managed subscription process and rejects incompatible BusyBox setpriv variants', async () => {
    const subscription = await readFile('runtime/v2/modules/38-subscription.sh', 'utf8');
    const service = await readFile('runtime/v2/modules/40-service.sh', 'utf8');
    expect(subscription).toContain('while [ "$subscription_wait" -lt 5 ]');
    expect(subscription).toContain('kill -KILL "$subscription_pid"');
    expect(subscription).toContain("*' httpd '*\" -h $TSUB_STATE/subscription-web\"*");
    expect(subscription).toContain('cp -pR "$TSUB_STATE/subscription-web"');
    expect(subscription).toContain('find "$TSUB_STATE/subscription-web/cgi-bin" -type f -exec chmod 750');
    expect(subscription).toContain("setpriv --help 2>&1 | grep -q -- '--reuid'");
    expect(service).toContain("setpriv --help 2>&1 | grep -q -- '--reuid'");
  });

  it('schedules active pushes relative to timer activation after every apply', async () => {
    const source = await readFile('runtime/v2/modules/39-push.sh', 'utf8');
    expect(source).toContain('OnActiveSec=${push_interval}m');
    expect(source).not.toContain('OnBootSec=2m');
    expect(source).toContain('systemctl restart tsub-push.timer');
  });

  it('does not install periodic push jobs without a running scheduler', async () => {
    const push = await readFile('runtime/v2/modules/39-push.sh', 'utf8');
    const dependencies = await readFile('runtime/v2/modules/15-dependencies.sh', 'utf8');
    expect(push).toContain('&& scheduler_is_running; then');
    expect(push).toContain('start_scheduler_service');
    expect(push).toContain('migrate_tsub_scheduler_service');
    expect(push).toContain('rc-service dcron start');
    expect(push).toContain('command_args="-f -S -c /etc/crontabs"');
    expect(push).toContain('TSub-managed scheduler');
    expect(push).toContain('remove_tsub_scheduler_service');
    const maintenance = await readFile('runtime/v2/modules/55-maintenance.sh', 'utf8');
    expect(maintenance).toContain('remove_tsub_scheduler_service');
    expect(push.match(/remove_tsub_scheduler_service/g)).toHaveLength(1);
    expect(push).toContain('>>$TSUB_LOG 2>&1');
    expect(dependencies).toContain('dependency_package_for_scheduler');
    expect(dependencies).toContain('dependency_add_missing cron');
    expect(dependencies).toContain('&& ! have crontab; then');
  });

  it('records successful configuration changes and reports uninstall completion only after cleanup', async () => {
    const main = await readFile('runtime/v2/modules/90-main.sh', 'utf8');
    const transaction = await readFile('runtime/v2/modules/50-transaction.sh', 'utf8');
    expect(main).toContain('apply|update|repair) plan_runtime; apply_runtime; record_runtime_change_time; print_runtime_summary');
    expect(main).toContain('rollback) load_installed_core; rollback_runtime; record_runtime_change_time');
    expect(main).not.toMatch(/restart\).*record_runtime_change_time/);
    expect(transaction.indexOf('push_uninstall_event || true')).toBeLessThan(transaction.indexOf('subscription_remove'));
    expect(transaction.indexOf("emit_event succeeded \"$(i18n_text '卸载完成' 'Uninstall completed')\"")).toBeLessThan(transaction.indexOf("i18n_print 'TSub Proxy 卸载成功'"));
  });

  it('allows an unchanged update to reuse a verified installed core before enforcing change headroom', async () => {
    const plan = await readFile('runtime/v2/modules/20-plan.sh', 'utf8');
    const transaction = await readFile('runtime/v2/modules/50-transaction.sh', 'utf8');
    expect(plan).toContain('planned_core_is_installed || require_install_headroom');
    expect(plan).toContain('planned_sha=$(kv_get "${core}_${TSUB_ARCH}_binary_sha256")');
    expect(plan).toContain('[ -x "$planned_target" ] && [ "$(sha256_file "$planned_target")" = "$planned_sha" ]');
    expect(transaction.indexOf("emit_event succeeded \"$(i18n_text '配置未发生变化' 'Configuration unchanged')\"")).toBeLessThan(transaction.indexOf('TSUB_CORE_DOWNLOADED'));
    expect(transaction).toContain('[ "${TSUB_CORE_DOWNLOADED:-false}" != true ] || require_install_headroom');
    expect(transaction.indexOf('TSUB_CORE_DOWNLOADED')).toBeLessThan(transaction.indexOf('validate_config "$apply_candidate"'));
    expect(transaction).toContain('[ "${action:-}" = repair ]');
  });

  it('requires an explicit interactive confirmation before forcing a low-memory install', async () => {
    const plan = await readFile('runtime/v2/modules/20-plan.sh', 'utf8');
    const main = await readFile('runtime/v2/modules/90-main.sh', 'utf8');
    expect(plan).toContain('confirm_low_memory_install()');
    expect(plan).toContain("confirmation_input=${TSUB_CONFIRM_INPUT:-/dev/tty}");
    expect(plan).toContain("y|Y)");
    expect(plan).toContain('i18n_degraded "用户已确认低内存强制安装"');
    expect(plan).toContain('当前为非交互执行，无法确认强制安装');
    expect(main).toContain('TSUB_FORCE_LOW_MEMORY_INSTALL=false');
  });

  it('restarts a manually updated agent but never restarts the running agent process itself', async () => {
    const agent = await readFile('runtime/v2/modules/38-agent.sh', 'utf8');
    const maintenance = await readFile('runtime/v2/modules/55-maintenance.sh', 'utf8');
    expect(agent).toContain('[ "${TSUB_AGENT_RUNNING:-false}" = true ] && return 0');
    expect(agent).toContain('systemctl restart tsub-agent.service');
    expect(agent).not.toContain('systemctl enable --now tsub-agent.service');
    expect(maintenance).toContain('persist_bootstrap_config=$TSUB_CONFIG');
    expect(maintenance.indexOf('TSUB_CONFIG=$persistent_config')).toBeLessThan(maintenance.indexOf('install_agent_service "$runtime_target" "$persistent_config"'));
    expect(maintenance).toContain('TSUB_CONFIG=$persist_bootstrap_config');
  });

  it('checks optional component caches with unpacked binary hashes and renews active command leases', async () => {
    const provider = await readFile('runtime/v2/modules/30-provider.sh', 'utf8');
    const tunnel = await readFile('runtime/v2/modules/32-tunnel.sh', 'utf8');
    const certificate = await readFile('runtime/v2/modules/33-certificate.sh', 'utf8');
    const secrets = await readFile('runtime/v2/modules/31-secrets.sh', 'utf8');
    const subscription = await readFile('runtime/v2/modules/38-subscription.sh', 'utf8');
    const agent = await readFile('runtime/v2/modules/38-agent.sh', 'utf8');

    expect(provider).toContain('component_binary_sha()');
    expect(tunnel).toContain('expected=$(component_binary_sha cloudflared)');
    expect(certificate).toContain('expected=$(component_binary_sha lego)');
    expect(secrets).toContain('expected=$(component_binary_sha wgcf)');
    expect(subscription).toContain('subscription_expected=$(component_binary_sha busybox)');
    expect(agent).toContain('"leaseRenewal":true');
    expect(agent).toContain('agent_lease_renew_loop');
    expect(agent).toContain('agent_resources="\\"nodeCount\\":$agent_node_count"');
    expect(agent).toContain('\\"edgeProbe\\":{\\"ok\\":$agent_probe_ws');
    expect(agent).toContain('agent_failure_summary');
    expect(tunnel).toContain('"$TSUB_STATE"/tunnel-*.pid');
    expect(tunnel).toContain('tunnel_config_hash()');
    expect(tunnel).toContain('if [ "$count" -le 0 ]; then');
    const transaction = await readFile('runtime/v2/modules/50-transaction.sh', 'utf8');
    expect(transaction).toContain('[ "$tunnel_candidate_hash" != "$tunnel_current_hash" ]');
    expect(transaction).toContain('"$TSUB_STATE/tunnel.config.hash"');
  });

  it('makes Quick Tunnel monitor credentials accessible only to the service user', async () => {
    const service = await readFile('runtime/v2/modules/40-service.sh', 'utf8');
    expect(service).toContain('chown "$TSUB_SERVICE_USER:$service_group" "$TSUB_STATE/quick-tunnel-monitor.sh"');
    expect(service).toContain('chmod 700 "$TSUB_STATE/quick-tunnel-monitor.sh"');
    expect(service).toContain('"$TSUB_STATE/quick-tunnel.meta"');
    expect(service).toContain('"$TSUB_STATE/quick-tunnel.token"');
    expect(service).toContain('"$TSUB_STATE"/quick-tunnel-monitor-*.pid');
  });

  it('allows remote node synchronization and pushes the refreshed snapshot', async () => {
    const [agent, executor, main] = await Promise.all([
      readFile('runtime/v2/modules/38-agent.sh', 'utf8'),
      readFile('server/executor/tsub-local-executor.sh', 'utf8'),
      readFile('runtime/v2/modules/90-main.sh', 'utf8')
    ]);
    expect(agent).toMatch(/case "\$agent_action" in [^\n]*\|list\|/);
    expect(agent).toContain('"osPrettyName":"%s"');
    expect(agent).toContain('"hostname":"%s"');
    expect(executor).toMatch(/case "\$action" in [^\n]*\|list\|/);
    expect(executor).toContain('"osPrettyName":"%s"');
    expect(executor).toContain('"hostname":"%s"');
    expect(executor).toContain('RUNTIME_SOURCE=${TSUB_RUNTIME_SOURCE_PATH:-/opt/tsub-controller/dist/proxy/v2/tsub-proxy.sh}');
    expect(executor).toContain('command_runtime=$(executor_runtime_path)');
    expect(main).toContain("list) export_nodes; push_snapshot || i18n_die \"节点同步推送失败\" \"Node synchronization push failed\"; emit_event succeeded \"$(i18n_text '节点导出完成' 'Nodes exported')\"");
    expect(main).toContain('restart) plan_runtime; load_installed_core; ensure_tunnel_binary; prepare_service_identity;');
  });

  it('suppresses unattended summaries and redacts runtime logs in place', async () => {
    const common = await readFile('runtime/v2/modules/00-common.sh', 'utf8');
    const maintenance = await readFile('runtime/v2/modules/55-maintenance.sh', 'utf8');
    const agent = await readFile('runtime/v2/modules/38-agent.sh', 'utf8');
    expect(common).toContain('redact_sensitive_stream');
    expect(common).toContain('cat "$redact_target" >"$TSUB_LOG"');
    expect(common).toContain('cat "$log_tail" >"$TSUB_LOG"');
    expect(maintenance).toContain('Environment=TSUB_SUPPRESS_SENSITIVE_OUTPUT=true');
    expect(agent).toContain('TSUB_SUPPRESS_SENSITIVE_OUTPUT=true');
    expect(agent).toContain('append_redacted_log "$agent_command_log"');
  });

  it('localizes service lifecycle output and suppresses successful systemd symlink noise', async () => {
    const service = await readFile('runtime/v2/modules/40-service.sh', 'utf8');
    const common = await readFile('runtime/v2/modules/00-common.sh', 'utf8');
    const menu = await readFile('runtime/v2/modules/56-control-menu.sh', 'utf8');
    expect(common).toContain('runtime_output_language');
    expect(service).toContain('正在启用并启动 TSub 核心服务，请稍候');
    expect(service).toContain('Enabling and starting the TSub core service');
    expect(service).toContain('systemctl enable --now tsub-core.service >>"$systemd_output" 2>&1');
    expect(service).toContain('cat "$systemd_output" >&2');
    expect(service).toContain('while [ "$health_elapsed" -lt "$wait_seconds" ]');
    expect(service).toContain('Health check passed; the TSub core service is running normally.');
    expect(menu).toContain('TSub Proxy control menu');
    expect(service).not.toContain('Created symlink');
  });
});
