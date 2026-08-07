verify_download() {
  component=$1
  output=$2
  url=$(kv_get "${component}_${TSUB_ARCH}_url")
  expected=$(kv_get "${component}_${TSUB_ARCH}_sha256")
  format=$(kv_get "${component}_${TSUB_ARCH}_format"); format=${format:-binary}
  binary_expected=$(kv_get "${component}_${TSUB_ARCH}_binary_sha256"); binary_expected=${binary_expected:-$expected}
  [ -n "$url" ] && [ -n "$expected" ] || i18n_die "$component/$TSUB_ARCH 缺少版本清单或 SHA-256" "$component/$TSUB_ARCH is missing a manifest entry or SHA-256"
  TSUB_DOWNLOAD_PART="$output.part"
  i18n_print "正在下载 $component 核心组件..." "Downloading the $component core component..."
  download_file "$url" "$TSUB_DOWNLOAD_PART"
  i18n_print "下载完成，正在校验 $component..." "Download completed; verifying $component..."
  actual=$(sha256_file "$TSUB_DOWNLOAD_PART")
  [ "$actual" = "$expected" ] || i18n_die "$component 校验失败" "$component verification failed"
  case "$format" in
    binary)
      [ "$actual" = "$binary_expected" ] || i18n_die "$component 二进制校验失败" "$component binary verification failed"
      chmod 755 "$TSUB_DOWNLOAD_PART"
      mv -f "$TSUB_DOWNLOAD_PART" "$output"
      ;;
    tar.gz)
      archive_listing="$TSUB_TMP/${component}.archive.list.$$"
      tar -tzf "$TSUB_DOWNLOAD_PART" >"$archive_listing" || i18n_die "$component 压缩包目录读取失败" "Could not read the $component archive listing"
      if grep -Eq '(^/|(^|/)\.\.(/|$))' "$archive_listing"; then i18n_die "$component 压缩包包含不安全路径" "The $component archive contains an unsafe path"; fi
      extracted_list="$TSUB_TMP/${component}.archive.candidates.$$"
      awk -F/ -v component="$component" '$NF == component { print }' "$archive_listing" >"$extracted_list"
      [ "$(wc -l <"$extracted_list" | tr -d ' ')" = 1 ] || i18n_die "$component 压缩包必须包含唯一二进制文件" "The $component archive must contain exactly one binary"
      extracted=$(sed -n '1p' "$extracted_list")
      extracted_file="$TSUB_TMP/${component}.binary.$$"
      tar -xOzf "$TSUB_DOWNLOAD_PART" "$extracted" >"$extracted_file" || i18n_die "$component 压缩包解压失败" "Failed to extract the $component archive"
      [ -s "$extracted_file" ] || i18n_die "$component 压缩包中的二进制文件为空" "The binary in the $component archive is empty"
      extracted_hash=$(sha256_file "$extracted_file")
      [ "$extracted_hash" = "$binary_expected" ] || i18n_die "$component 二进制校验失败" "$component binary verification failed"
      chmod 755 "$extracted_file"
      mv -f "$extracted_file" "$output"
      rm -f "$archive_listing" "$extracted_list" "$TSUB_DOWNLOAD_PART"
      ;;
    *) i18n_die "$component 资产格式不受支持" "Unsupported $component asset format" ;;
  esac
  TSUB_DOWNLOAD_PART=''
  i18n_print "$component 下载并校验完成。" "$component was downloaded and verified successfully."
}

component_binary_sha() {
  component=$1
  component_expected=$(kv_get "${component}_${TSUB_ARCH}_binary_sha256")
  [ -n "$component_expected" ] || component_expected=$(kv_get "${component}_${TSUB_ARCH}_sha256")
  printf '%s' "$component_expected"
}

ensure_core() {
  core=$(kv_get runtime_core)
  version=$(kv_get "${core}_version")
  expected=$(component_binary_sha "$core")
  [ -n "$expected" ] || i18n_die "$core/$TSUB_ARCH 缺少 SHA-256" "$core/$TSUB_ARCH is missing a SHA-256"
  target="$TSUB_BIN/$core-$version-$TSUB_ARCH-$expected"
  if [ -x "$target" ] && [ "$(sha256_file "$target")" != "$expected" ]; then rm -f "$target"; fi
  TSUB_CORE_DOWNLOADED=false
  if [ ! -x "$target" ]; then
    TSUB_STAGE=download
    verify_download "$core" "$target"
    TSUB_CORE_DOWNLOADED=true
  fi
  TSUB_CORE_BIN=$target
  TSUB_CORE_VERSION=$(basename "$target")
  TSUB_CORE_CHANGED=false
  previous_core=$(cat "$TSUB_STATE/core.identity" 2>/dev/null || true)
  TSUB_PREVIOUS_CORE=$previous_core
  [ "$previous_core" = "$TSUB_CORE_BIN" ] || TSUB_CORE_CHANGED=true
}

load_installed_core() {
  TSUB_CORE_BIN=$(cat "$TSUB_STATE/core.identity" 2>/dev/null || true)
  [ -n "$TSUB_CORE_BIN" ] && [ -x "$TSUB_CORE_BIN" ] || i18n_die "未找到已安装核心，请先执行 apply" "No installed core was found; run apply first"
  TSUB_CORE_VERSION=$(basename "$TSUB_CORE_BIN")
}

render_config() {
  core=$(kv_get runtime_core)
  output=$1
  b64_decode_file "${core}_config_b64" "$output" || i18n_die "$core 配置 Base64 解码失败或内容为空" "The $core configuration could not be decoded from Base64 or is empty"
  cert_dir="$TSUB_STATE/certificates/certificates"
  sed "s|__TSUB_CERT_DIR__|$cert_dir|g" "$output" >"$output.rendered"
  mv "$output.rendered" "$output"
  replace_runtime_secrets "$output"
  chmod 600 "$output"
}

validate_config() {
  core=$(kv_get runtime_core)
  config=$1
  case "$core" in
    xray) run_core_command "$TSUB_CORE_BIN" run -test -config "$config" >/dev/null 2>"$TSUB_TMP/validate.err" ;;
    sing-box) run_core_command "$TSUB_CORE_BIN" check -c "$config" >/dev/null 2>"$TSUB_TMP/validate.err" ;;
    naive) "$TSUB_CORE_BIN" validate --config "$config" --adapter caddyfile >/dev/null 2>"$TSUB_TMP/validate.err" ;;
  esac || i18n_die "核心配置检查失败: $(tail -c 300 "$TSUB_TMP/validate.err" 2>/dev/null)" "Core configuration validation failed: $(tail -c 300 "$TSUB_TMP/validate.err" 2>/dev/null)"
}

export_nodes() {
  TSUB_NODES_FILE="$TSUB_STATE/nodes.txt"
  b64_decode_file nodes_b64 "$TSUB_NODES_FILE" || : >"$TSUB_NODES_FILE"
  replace_runtime_secrets "$TSUB_NODES_FILE"
  TSUB_NODE_DETAILS_FILE="$TSUB_STATE/node-details.txt"
  b64_decode_file node_details_b64 "$TSUB_NODE_DETAILS_FILE" || : >"$TSUB_NODE_DETAILS_FILE"
  replace_runtime_secrets "$TSUB_NODE_DETAILS_FILE"
  apply_exported_certificate_pin || i18n_die "节点证书指纹写入失败" "Failed to write node certificate pins"
  chmod 600 "$TSUB_NODE_DETAILS_FILE"
  if [ -r "$TSUB_STATE/legacy-nodes.txt" ] && [ ! -s "$TSUB_NODES_FILE" ]; then
    cp "$TSUB_STATE/legacy-nodes.txt" "$TSUB_NODES_FILE"
  fi
  chmod 640 "$TSUB_NODES_FILE"
  if id tsub >/dev/null 2>&1; then
    chgrp "$(id -gn tsub)" "$TSUB_NODES_FILE" 2>/dev/null || true
  fi
}
