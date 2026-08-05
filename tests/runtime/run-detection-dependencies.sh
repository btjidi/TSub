#!/bin/sh
# shellcheck disable=SC2034
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
. "$ROOT/runtime/v2/modules/00-common.sh"
. "$ROOT/runtime/v2/modules/10-detect.sh"
. "$ROOT/runtime/v2/modules/15-dependencies.sh"

TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tsub-detect.XXXXXX")
trap 'rm -rf "$TEST_TMP"' EXIT HUP INT TERM
TSUB_CONFIG="$TEST_TMP/runtime.conf"
printf 'padding=dGVzdA==\nudp_hop_rules=\n' >"$TSUB_CONFIG"
[ "$(kv_get padding)" = 'dGVzdA==' ]

check_system() {
  expected_os=$1 expected_family=$2
  TSUB_OS_RELEASE_FILE=$3
  detect_system_identity >"$TEST_TMP/system.out"
  [ "$TSUB_OS" = "$expected_os" ]
  [ "$TSUB_OS_FAMILY" = "$expected_family" ]
  grep -q '系统类型：' "$TEST_TMP/system.out"
  grep -q 'CPU 架构：' "$TEST_TMP/system.out"
  grep -q '运行环境：' "$TEST_TMP/system.out"
  grep -q '初步资源档位：' "$TEST_TMP/system.out"
}

printf 'ID=alpine\nVERSION_ID=3.21\nPRETTY_NAME="Alpine Linux v3.21"\n' >"$TEST_TMP/alpine"
check_system alpine alpine "$TEST_TMP/alpine"
printf 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04 LTS"\nID_LIKE=debian\n' >"$TEST_TMP/ubuntu"
check_system ubuntu debian "$TEST_TMP/ubuntu"
printf 'ID=rocky\nVERSION_ID=9.5\nPRETTY_NAME="Rocky Linux 9.5"\nID_LIKE="rhel fedora"\n' >"$TEST_TMP/rocky"
check_system rocky rhel "$TEST_TMP/rocky"
grep -q '^SELinux：' "$TEST_TMP/system.out"
printf 'ID=custom\nVERSION_ID=1\nPRETTY_NAME="Custom Linux"\nID_LIKE="debian ubuntu"\n' >"$TEST_TMP/derived"
check_system custom debian "$TEST_TMP/derived"
[ "$TSUB_OS_VERIFIED" = false ]
check_system unknown unknown "$TEST_TMP/missing"

TSUB_OS_FAMILY=debian
[ "$(dependency_package_for_command ss)" = iproute2 ]
[ "$(dependency_package_for_command openssl)" = openssl ]
[ "$(dependency_package_for_command sed)" = sed ]
[ "$(dependency_package_for_command awk)" = mawk ]
TSUB_OS_FAMILY=alpine
[ "$(dependency_package_for_command ss)" = iproute2 ]
[ "$(dependency_package_for_command openssl)" = openssl ]
[ "$(dependency_package_for_command grep)" = busybox ]
TSUB_OS_FAMILY=rhel
[ "$(dependency_package_for_command ss)" = iproute ]
[ "$(dependency_package_for_command openssl)" = openssl ]
[ "$(dependency_package_for_command awk)" = gawk ]

have() { [ "$1" != ss ]; }
dependency_ca_available() { return 0; }
TSUB_OS_FAMILY=debian
if ensure_dependencies plan >"$TEST_TMP/plan.out" 2>&1; then exit 1; fi
grep -q '计划模式不会修改系统' "$TEST_TMP/plan.out"
grep -q 'iproute2' "$TEST_TMP/plan.out"

mkdir -p "$TEST_TMP/bin"
cat >"$TEST_TMP/bin/apt-get" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$TSUB_TEST_APT_LOG"
case " $* " in *" install "*) : >"$TSUB_TEST_SS_READY" ;; esac
exit 0
EOF
chmod 755 "$TEST_TMP/bin/apt-get"
TSUB_TEST_APT_LOG="$TEST_TMP/apt.log"; TSUB_TEST_SS_READY="$TEST_TMP/ss.ready"
export TSUB_TEST_APT_LOG TSUB_TEST_SS_READY
PATH="$TEST_TMP/bin:$PATH"; export PATH
have() {
  case "$1" in
    ss) [ -f "$TSUB_TEST_SS_READY" ] ;;
    *) command -v "$1" >/dev/null 2>&1 ;;
  esac
}
id() { [ "${1:-}" = -u ] && { printf '0\n'; return 0; }; command id "$@"; }
dependency_ca_available() { return 0; }
TSUB_OS_FAMILY=debian
ensure_dependencies apply >"$TEST_TMP/apply.out"
grep -q '^update -qq$' "$TSUB_TEST_APT_LOG"
grep -q 'install -y --no-install-recommends iproute2' "$TSUB_TEST_APT_LOG"
grep -q '^clean$' "$TSUB_TEST_APT_LOG"
grep -q '依赖安装：完成' "$TEST_TMP/apply.out"

printf 'certificate_mode=self-signed\n' >>"$TSUB_CONFIG"
have() {
  case "$1" in
    openssl) return 1 ;;
    *) command -v "$1" >/dev/null 2>&1 ;;
  esac
}
TSUB_OS_FAMILY=debian
detect_required_dependencies repair
case " ${TSUB_MISSING_DEPENDENCIES:-} " in *' openssl '*) ;; *) exit 1 ;; esac
case " ${TSUB_REQUIRED_PACKAGES:-} " in *' openssl '*) ;; *) exit 1 ;; esac

# A newly installed scheduler is not running until the apply phase starts it.
# Its crontab command is sufficient for dependency detection at this stage.
printf 'push_enabled=true\npush_url=https://controller.example/api/deploy/push/test\n' >>"$TSUB_CONFIG"
TSUB_INIT=openrc
have() {
  case "$1" in
    crontab) return 0 ;;
    *) command -v "$1" >/dev/null 2>&1 ;;
  esac
}
detect_required_dependencies apply
case " ${TSUB_MISSING_DEPENDENCIES:-} " in *' cron '*) exit 1 ;; esac

# Production sing-box assets are glibc-linked binaries, so Alpine needs
# gcompat regardless of whether the provider uses binary or tar.gz format.
printf 'runtime_core=sing-box\nsing-box_amd64_format=binary\n' >>"$TSUB_CONFIG"
TSUB_OS_FAMILY=alpine
TSUB_ARCH=amd64
dependency_glibc_loader_available() { return 1; }
detect_required_dependencies apply
case " ${TSUB_MISSING_DEPENDENCIES:-} " in *' glibc-compat '*) ;; *) exit 1 ;; esac
case " ${TSUB_REQUIRED_PACKAGES:-} " in *' gcompat '*) ;; *) exit 1 ;; esac
dependency_glibc_loader_available() { return 0; }
detect_required_dependencies apply
case " ${TSUB_MISSING_DEPENDENCIES:-} " in *' glibc-compat '*) exit 1 ;; esac
case " ${TSUB_REQUIRED_PACKAGES:-} " in *' gcompat '*) exit 1 ;; esac

printf 'detection and dependency tests passed\n'
