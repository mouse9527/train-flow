#!/usr/bin/env bash
set -u

scan_root=${PRIVACY_SCAN_ROOT:-}
if [[ -z "$scan_root" ]]; then
  scan_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 2
fi
cd "$scan_root" || exit 2

failed=0
require_screenshots=${PRIVACY_SCAN_REQUIRE_SCREENSHOTS:-1}

report() {
  printf '%s %s\n' "$1" "$2"
  failed=1
}

is_scanned_path() {
  case "$1" in
    project.config.json|package.json|package-lock.json|README.md|\
    miniprogram/*|tests/*|cloudfunctions/*|scripts/*|evidence/screenshots/*|evidence/logs/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_allowed_sentinel_line() {
  local file=$1
  local line=$2
  [[ "$line" == *PRIVACY_SCAN_RULE_DEFINITION* || "$line" == *PRIVACY_SCAN_TEST_SENTINEL* ]] && return 0
  case "$file" in
    tests/cloudfunctions/cloud-sync-security.test.js)
      [[ "$line" == *test-* || "$line" == *nested-secret* ]]
      ;;
    tests/domain/planning/default-plan-initialization.test.js)
      [[ "$line" == *forged-* ]]
      ;;
    tests/domain/sync/entity-mapper-conflicts.test.js)
      [[ "$line" == *must-not-* ]]
      ;;
    tests/e2e/app-shell-golden-path.test.js)
      [[ "$line" == *oFixtureOnly* || "$line" == *fixture-secret* ||
        "$line" == *张三* || "$line" == *李四* || "$line" == *1380013*8000* ||
        "$line" == *110105194*31002X* ]]
      ;;
    tests/e2e/cloud-sync-security-golden-path.test.js)
      [[ "$line" == *e2e-* ]]
      ;;
    tests/integration/app-shell-settings.test.js)
      [[ "$line" == *oX123* ]]
      ;;
    tests/integration/settings-persistence.test.js|tests/services/local-database.test.js)
      [[ "$line" == *must-not-* || "$line" == *checksum-valid* ||
        "$line" == *not-covered* || "$line" == *covered-by* ]]
      ;;
    tests/integration/data-import-export.test.js)
      [[ "$line" == *PRIVATE_CODE_TOKEN_9ea1* ]]
      ;;
    *)
      return 1
      ;;
  esac
}

scan_pattern() {
  local category=$1
  local file=$2
  local pattern=$3
  local match
  local line
  while IFS= read -r match; do
    [[ -n "$match" ]] || continue
    line=${match#*:}
    if is_allowed_sentinel_line "$file" "$line"; then
      printf '%s %s\n' TEST_ONLY_SENTINEL "$file"
    else
      report "$category" "$file"
    fi
  done < <(LC_ALL=C grep -Ein "$pattern" "$file" 2>/dev/null || true)
}

absolute_path_pattern='/Users/' # PRIVACY_SCAN_RULE_DEFINITION
real_appid_pattern='wx[0-9a-fA-F]{16}([^0-9a-fA-F]|$)' # PRIVACY_SCAN_RULE_DEFINITION
direct_database_pattern='wx[[:space:]]*\.[[:space:]]*cloud[[:space:]]*\.[[:space:]]*database[[:space:]]*\(' # PRIVACY_SCAN_RULE_DEFINITION
pii_assignment_pattern='["'"'"'`]?((realName|fullName|legalName|patientName|userName))["'"'"'`]?[[:space:]]*[:=][[:space:]]*["'"'"'`][^"'"'"'`]+' # PRIVACY_SCAN_RULE_DEFINITION
pii_number_pattern='(^|[^0-9])(1[3-9][0-9]{9}|[0-9]{17}[0-9Xx])([^0-9]|$)' # PRIVACY_SCAN_RULE_DEFINITION
credential_pattern='["'"'"'`]?(appSecret|password|privateKey|session_key|sessionKey|authToken|accessToken|openId|openid)["'"'"'`]?[[:space:]]*[:=][[:space:]]*["'"'"'`][^"'"'"'`]+' # PRIVACY_SCAN_RULE_DEFINITION
log_payload_pattern='["'"'"'`]?(openId|openid|ownerId|authToken|accessToken|session_key|trainingRecord|recordPayload|requestPayload|responsePayload)["'"'"'`]?[[:space:]]*[:=]' # PRIVACY_SCAN_RULE_DEFINITION

while IFS= read -r -d '' file; do
  is_scanned_path "$file" || continue
  [[ -f "$file" ]] || continue
  grep -Iq . "$file" || continue

  scan_pattern ABSOLUTE_USER_PATH "$file" "$absolute_path_pattern"
  scan_pattern REAL_WECHAT_APPID "$file" "$real_appid_pattern"

  if [[ "$file" == miniprogram/* ]]; then
    scan_pattern DIRECT_MINIPROGRAM_DATABASE "$file" "$direct_database_pattern"
  fi

  scan_pattern PII_LITERAL "$file" "$pii_assignment_pattern"
  scan_pattern PII_LITERAL "$file" "$pii_number_pattern"
  scan_pattern CREDENTIAL_ASSIGNMENT "$file" "$credential_pattern"

  if [[ "$file" == evidence/logs/* ]]; then
    scan_pattern EVIDENCE_LOG_PRIVATE_PAYLOAD "$file" "$log_payload_pattern"
  fi
done < <(git ls-files -z)

screenshot_dir=evidence/screenshots
manifest=$screenshot_dir/manifest.tsv
if [[ -d "$screenshot_dir" ]]; then
  if [[ ! -f "$manifest" ]]; then
    report SCREENSHOT_MANIFEST_MISSING "$manifest"
  elif ! git ls-files --error-unmatch "$manifest" >/dev/null 2>&1; then
    report SCREENSHOT_MANIFEST_UNTRACKED "$manifest"
  else
    header=$(head -n 1 "$manifest")
    expected_header=$'route\thead\ttree\tsha256\tdata_source\tmanual_visual_verdict\tfile'
    if [[ "$header" != "$expected_header" ]]; then
      report SCREENSHOT_MANIFEST_SCHEMA "$manifest"
    else
      row_count=0
      while IFS=$'\t' read -r route head tree digest data_source verdict image_file extra; do
        [[ -n "$route$head$tree$digest$data_source$verdict$image_file" ]] || continue
        row_count=$((row_count + 1))
        if [[ -n "$extra" || -z "$route" || ! "$head" =~ ^[a-f0-9]{40}$ ||
          ! "$tree" =~ ^[a-f0-9]{40}$ || ! "$digest" =~ ^[a-f0-9]{64}$ ||
          ! "$data_source" =~ ^(anonymous|synthetic|clean-local)[A-Za-z0-9._-]*$ ||
          "$verdict" != PASS ]]; then
          report SCREENSHOT_MANIFEST_ENTRY "$manifest"
          continue
        fi
        if [[ "$image_file" == /* || "$image_file" == *..* || "$image_file" == *\\* ||
          "$image_file" != *.png ]]; then
          report SCREENSHOT_PATH_INVALID "$manifest"
          continue
        fi
        image_path=$screenshot_dir/$image_file
        if [[ ! -f "$image_path" ]]; then
          report SCREENSHOT_FILE_MISSING "$image_path"
          continue
        fi
        if ! git ls-files --error-unmatch "$image_path" >/dev/null 2>&1; then
          report SCREENSHOT_FILE_UNTRACKED "$image_path"
        fi
        if ! git cat-file -e "$head^{commit}" 2>/dev/null; then
          report SCREENSHOT_SOURCE_UNRESOLVED "$manifest"
        else
          source_tree=$(git rev-parse "$head^{tree}")
          [[ "$source_tree" == "$tree" ]] || report SCREENSHOT_SOURCE_TREE_MISMATCH "$manifest"
          git diff --quiet "$head" -- miniprogram cloudfunctions project.config.json package.json ||
            report SCREENSHOT_SOURCE_STALE "$manifest"
        fi
        if command -v sha256sum >/dev/null 2>&1; then
          actual_digest=$(sha256sum "$image_path" | awk '{print $1}')
        else
          actual_digest=$(shasum -a 256 "$image_path" | awk '{print $1}')
        fi
        [[ "$actual_digest" == "$digest" ]] || report SCREENSHOT_HASH_MISMATCH "$image_path"
      done < <(tail -n +2 "$manifest")
      [[ "$row_count" -gt 0 ]] || report SCREENSHOT_MANIFEST_EMPTY "$manifest"
    fi
  fi
else
  if [[ "$require_screenshots" == 1 ]]; then
    report SCREENSHOT_EVIDENCE_ABSENT "$screenshot_dir"
  else
    printf '%s %s\n' SCREENSHOT_EVIDENCE_ABSENT "$screenshot_dir"
  fi
fi

exit "$failed"
