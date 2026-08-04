#!/usr/bin/env bash
set -u

scan_root=${PRIVACY_SCAN_ROOT:-}
if [[ -z "$scan_root" ]]; then
  scan_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 2
fi
cd "$scan_root" || exit 2

failed=0

report() {
  printf '%s %s\n' "$1" "$2"
  failed=1
}

is_scanner_sentinel() {
  [[ "$1" == "scripts/privacy-scan.sh" || "$1" == "tests/e2e/train-flow-critical.e2e.test.js" ]]
}

is_test_path() {
  [[ "$1" == tests/* || "$1" == */tests/* || "$1" == *.test.js ]]
}

is_scanned_path() {
  case "$1" in
    miniprogram/*|tests/*|cloudfunctions/*|scripts/*|evidence/screenshots/*|evidence/logs/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

while IFS= read -r -d '' file; do
  is_scanned_path "$file" || continue
  [[ -f "$file" ]] || continue
  grep -Iq . "$file" || continue

  if ! is_scanner_sentinel "$file"; then
    grep -Eq '/Users/' "$file" && report ABSOLUTE_USER_PATH "$file"
    grep -Eq 'wx[0-9a-fA-F]{16}([^0-9a-fA-F]|$)' "$file" && report REAL_WECHAT_APPID "$file"
  fi

  if [[ "$file" == miniprogram/* ]] &&
    grep -Eq 'wx[[:space:]]*\.[[:space:]]*cloud[[:space:]]*\.[[:space:]]*database[[:space:]]*\(' "$file"; then
    report DIRECT_MINIPROGRAM_DATABASE "$file"
  fi

  if ! is_test_path "$file" && ! is_scanner_sentinel "$file"; then
    if grep -Eqi '(realName|fullName|legalName|patientName|userName)[[:space:]]*[:=][[:space:]]*["'"'"'`][^"'"'"'`]+' "$file" ||
      grep -Eq '\b1[3-9][0-9]{9}\b|\b[0-9]{17}[0-9Xx]\b' "$file"; then
      report PII_LITERAL "$file"
    fi
    if grep -Eqi '(appSecret|password|privateKey|session_key|sessionKey|authToken|accessToken|openId|openid)[[:space:]]*[:=][[:space:]]*["'"'"'`][^"'"'"'`]+' "$file"; then
      report CREDENTIAL_ASSIGNMENT "$file"
    fi
  fi

  if [[ "$file" == evidence/logs/* ]] &&
    grep -Eqi '(openId|openid|ownerId|authToken|accessToken|session_key|trainingRecord|recordPayload|requestPayload|responsePayload)[[:space:]]*[:=]' "$file"; then
    report EVIDENCE_LOG_PRIVATE_PAYLOAD "$file"
  fi
done < <(git ls-files -z)

screenshot_dir=evidence/screenshots
manifest=$screenshot_dir/manifest.tsv
if [[ -d "$screenshot_dir" ]]; then
  if [[ ! -f "$manifest" ]]; then
    report SCREENSHOT_MANIFEST_MISSING "$manifest"
  else
    header=$(head -n 1 "$manifest")
    expected_header=$'route\thead\ttree\tsha256\tdata_source\tmanual_visual_verdict\tfile'
    if [[ "$header" != "$expected_header" ]]; then
      report SCREENSHOT_MANIFEST_SCHEMA "$manifest"
    else
      while IFS=$'\t' read -r route head tree digest data_source verdict image_file; do
        [[ -n "$route$head$tree$digest$data_source$verdict$image_file" ]] || continue
        if [[ -z "$route" || ! "$head" =~ ^[a-f0-9]{40}$ || ! "$tree" =~ ^[a-f0-9]{40}$ ||
          ! "$digest" =~ ^[a-f0-9]{64}$ || -z "$data_source" ||
          ! "$verdict" =~ ^(PASS|FAIL|BLOCKED)$ || ! -f "$screenshot_dir/$image_file" ]]; then
          report SCREENSHOT_MANIFEST_ENTRY "$manifest"
          continue
        fi
        if command -v sha256sum >/dev/null 2>&1; then
          actual_digest=$(sha256sum "$screenshot_dir/$image_file" | awk '{print $1}')
        else
          actual_digest=$(shasum -a 256 "$screenshot_dir/$image_file" | awk '{print $1}')
        fi
        [[ "$actual_digest" == "$digest" ]] || report SCREENSHOT_HASH_MISMATCH "$screenshot_dir/$image_file"
      done < <(tail -n +2 "$manifest")
    fi
  fi
else
  printf '%s %s\n' SCREENSHOT_EVIDENCE_ABSENT "$screenshot_dir"
fi

exit "$failed"
