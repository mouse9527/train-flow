#!/usr/bin/env bash
set -u

scan_root=${PRIVACY_SCAN_ROOT:-}
if [[ -z "$scan_root" ]]; then
  scan_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 2
fi
cd "$scan_root" || exit 2

failed=0
require_screenshots=${PRIVACY_SCAN_REQUIRE_SCREENSHOTS:-1}
require_logs=${PRIVACY_SCAN_REQUIRE_LOGS:-$require_screenshots}
expected_head=${PRIVACY_SCAN_EXPECTED_HEAD:-$(git rev-parse HEAD 2>/dev/null || true)}
expected_tree=${PRIVACY_SCAN_EXPECTED_TREE:-$(git rev-parse HEAD^{tree} 2>/dev/null || true)}

report() {
  printf '%s %s\n' "$1" "$2"
  failed=1
}

has_nul_byte() {
  LC_ALL=C od -An -tx1 "$1" | grep -Eq '(^|[[:space:]])00([[:space:]]|$)'
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
  if [[ "$file" == scripts/privacy-scan.sh && "$line" == *PRIVACY_SCAN_RULE_DEFINITION* ]]; then
    return 0
  fi
  if [[ "$file" == tests/e2e/train-flow-critical.e2e.test.js &&
    "$line" == *PRIVACY_SCAN_TEST_SENTINEL* ]]; then
    return 0
  fi
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
  if [[ "$file" == evidence/logs/*.log && -s "$file" ]] &&
    { has_nul_byte "$file" || ! grep -Iq . "$file"; }; then
    report EVIDENCE_LOG_BINARY "$file"
    continue
  fi
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
      manifest_images=()
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
        manifest_images[${#manifest_images[@]}]=$image_path
        if [[ ! -f "$image_path" ]]; then
          report SCREENSHOT_FILE_MISSING "$image_path"
          continue
        fi
        if [[ -L "$image_path" ]]; then
          report SCREENSHOT_FILE_SYMLINK "$image_path"
          continue
        fi
        if ! git ls-files --error-unmatch "$image_path" >/dev/null 2>&1; then
          report SCREENSHOT_FILE_UNTRACKED "$image_path"
        fi
        signature=$(LC_ALL=C od -An -tx1 -N8 "$image_path" | tr -d ' \n')
        [[ "$signature" == 89504e470d0a1a0a ]] || report SCREENSHOT_SIGNATURE_INVALID "$image_path"
        [[ "$head" == "$expected_head" ]] || report SCREENSHOT_SOURCE_HEAD_MISMATCH "$manifest"
        [[ "$tree" == "$expected_tree" ]] || report SCREENSHOT_SOURCE_TREE_MISMATCH "$manifest"
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
      while IFS= read -r -d '' tracked_image; do
        listed=0
        for declared_image in "${manifest_images[@]}"; do
          if [[ "$declared_image" == "$tracked_image" ]]; then
            listed=1
            break
          fi
        done
        [[ "$listed" -eq 1 ]] || report SCREENSHOT_UNLISTED "$tracked_image"
      done < <(git ls-files -z "$screenshot_dir" | while IFS= read -r -d '' candidate; do
        [[ "$candidate" == *.png ]] && printf '%s\0' "$candidate"
      done)
    fi
  fi
else
  if [[ "$require_screenshots" == 1 ]]; then
    report SCREENSHOT_EVIDENCE_ABSENT "$screenshot_dir"
  else
    printf '%s %s\n' SCREENSHOT_EVIDENCE_ABSENT "$screenshot_dir"
  fi
fi

log_dir=evidence/logs
log_manifest=$log_dir/manifest.tsv
if [[ "$require_logs" == 1 ]]; then
  if [[ ! -d "$log_dir" ]]; then
    report LOG_EVIDENCE_ABSENT "$log_dir"
  elif [[ ! -f "$log_manifest" ]]; then
    report LOG_MANIFEST_MISSING "$log_manifest"
  elif ! git ls-files --error-unmatch "$log_manifest" >/dev/null 2>&1; then
    report LOG_MANIFEST_UNTRACKED "$log_manifest"
  else
    log_header=$(head -n 1 "$log_manifest")
    expected_log_header=$'kind\thead\ttree\tsha256\tredaction_verdict\tfile'
    if [[ "$log_header" != "$expected_log_header" ]]; then
      report LOG_MANIFEST_SCHEMA "$log_manifest"
    else
      log_row_count=0
      critical_log=0
      full_log=0
      privacy_log=0
      manifest_logs=()
      manifest_kinds=()
      while IFS=$'\t' read -r kind head tree digest verdict log_file extra; do
        [[ -n "$kind$head$tree$digest$verdict$log_file" ]] || continue
        log_row_count=$((log_row_count + 1))
        if [[ -n "$extra" || ! "$kind" =~ ^(critical-e2e|full-suite|privacy-scan)$ ||
          ! "$head" =~ ^[a-f0-9]{40}$ || ! "$tree" =~ ^[a-f0-9]{40}$ ||
          ! "$digest" =~ ^[a-f0-9]{64}$ || "$verdict" != PASS ]]; then
          report LOG_MANIFEST_ENTRY "$log_manifest"
          continue
        fi
        if [[ ! "$log_file" =~ ^[A-Za-z0-9._-]+\.log$ ]]; then
          report LOG_PATH_INVALID "$log_manifest"
          continue
        fi
        unique_binding=1
        for declared_kind in "${manifest_kinds[@]}"; do
          if [[ "$declared_kind" == "$kind" ]]; then
            report LOG_DUPLICATE_KIND "$log_manifest"
            unique_binding=0
            break
          fi
        done
        log_path=$log_dir/$log_file
        for declared_log in "${manifest_logs[@]}"; do
          if [[ "$declared_log" == "$log_path" ]]; then
            report LOG_DUPLICATE_FILE "$log_manifest"
            unique_binding=0
            break
          fi
        done
        manifest_kinds[${#manifest_kinds[@]}]=$kind
        manifest_logs[${#manifest_logs[@]}]=$log_path
        [[ "$head" == "$expected_head" ]] || report LOG_SOURCE_HEAD_MISMATCH "$log_manifest"
        [[ "$tree" == "$expected_tree" ]] || report LOG_SOURCE_TREE_MISMATCH "$log_manifest"
        if ! git cat-file -e "$head^{commit}" 2>/dev/null; then
          report LOG_SOURCE_UNRESOLVED "$log_manifest"
        else
          log_source_tree=$(git rev-parse "$head^{tree}")
          [[ "$log_source_tree" == "$tree" ]] || report LOG_SOURCE_TREE_MISMATCH "$log_manifest"
          git diff --quiet "$head" -- miniprogram cloudfunctions project.config.json package.json ||
            report LOG_SOURCE_STALE "$log_manifest"
        fi
        if [[ "$unique_binding" -eq 1 ]]; then
          case "$kind" in
            critical-e2e) critical_log=1 ;;
            full-suite) full_log=1 ;;
            privacy-scan) privacy_log=1 ;;
          esac
        fi
        if [[ ! -f "$log_path" ]]; then
          report LOG_FILE_MISSING "$log_path"
          continue
        fi
        if [[ -L "$log_path" ]]; then
          report LOG_FILE_SYMLINK "$log_path"
          continue
        fi
        if ! git ls-files --error-unmatch "$log_path" >/dev/null 2>&1; then
          report LOG_FILE_UNTRACKED "$log_path"
        fi
        if [[ ! -s "$log_path" ]]; then
          report LOG_FILE_EMPTY "$log_path"
          continue
        fi
        if has_nul_byte "$log_path" || ! grep -Iq . "$log_path"; then
          report LOG_FILE_BINARY "$log_path"
          continue
        fi
        case "$kind" in
          critical-e2e)
            expected_command='command: node --test tests/e2e/train-flow-critical.e2e.test.js'
            ;;
          full-suite)
            expected_command='command: npm test'
            ;;
          privacy-scan)
            expected_command='command: PRIVACY_SCAN_REQUIRE_SCREENSHOTS=0 PRIVACY_SCAN_REQUIRE_LOGS=0 bash scripts/privacy-scan.sh'
            ;;
        esac
        command_line=$(sed -n '1p' "$log_path")
        head_line=$(sed -n '2p' "$log_path")
        tree_line=$(sed -n '3p' "$log_path")
        exit_line=$(tail -n 1 "$log_path")
        if [[ "$command_line" != "$expected_command" ||
          "$head_line" != "source-head: $head" ||
          "$tree_line" != "source-tree: $tree" ||
          "$exit_line" != 'exit-code: 0' ]]; then
          report LOG_CONTENT_INVALID "$log_path"
        fi
        case "$kind" in
          critical-e2e|full-suite)
            tests_count=$(sed -n 's/^# tests \([0-9][0-9]*\)$/\1/p' "$log_path" | tail -n 1)
            pass_count=$(sed -n 's/^# pass \([0-9][0-9]*\)$/\1/p' "$log_path" | tail -n 1)
            fail_count=$(sed -n 's/^# fail \([0-9][0-9]*\)$/\1/p' "$log_path" | tail -n 1)
            if [[ -z "$tests_count" || -z "$pass_count" || "$fail_count" != 0 ||
              "$tests_count" -ne "$pass_count" ||
              ( "$kind" == critical-e2e && "$tests_count" -ne 4 ) ]]; then
              report LOG_RESULT_INVALID "$log_path"
            fi
            ;;
          privacy-scan)
            grep -Fxq 'PRIVACY_SCAN_PASS tracked-content' "$log_path" ||
              report LOG_RESULT_INVALID "$log_path"
            ;;
        esac
        if command -v sha256sum >/dev/null 2>&1; then
          actual_log_digest=$(sha256sum "$log_path" | awk '{print $1}')
        else
          actual_log_digest=$(shasum -a 256 "$log_path" | awk '{print $1}')
        fi
        [[ "$actual_log_digest" == "$digest" ]] || report LOG_HASH_MISMATCH "$log_path"
      done < <(tail -n +2 "$log_manifest")
      [[ "$log_row_count" -gt 0 ]] || report LOG_MANIFEST_EMPTY "$log_manifest"
      [[ "$critical_log" -eq 1 ]] || report LOG_REQUIRED_KIND_MISSING "$log_manifest"
      [[ "$full_log" -eq 1 ]] || report LOG_REQUIRED_KIND_MISSING "$log_manifest"
      [[ "$privacy_log" -eq 1 ]] || report LOG_REQUIRED_KIND_MISSING "$log_manifest"
      while IFS= read -r -d '' tracked_log; do
        [[ "$tracked_log" == "$log_manifest" ]] && continue
        listed=0
        for declared_log in "${manifest_logs[@]}"; do
          if [[ "$declared_log" == "$tracked_log" ]]; then
            listed=1
            break
          fi
        done
        [[ "$listed" -eq 1 ]] || report LOG_UNLISTED "$tracked_log"
      done < <(git ls-files -z "$log_dir" | while IFS= read -r -d '' candidate; do
        [[ "$candidate" == *.log ]] && printf '%s\0' "$candidate"
      done)
    fi
  fi
fi

if [[ "$failed" -eq 0 ]]; then
  printf '%s %s\n' PRIVACY_SCAN_PASS tracked-content
fi
exit "$failed"
