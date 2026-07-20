#!/usr/bin/env bash

# merge-game-data.sh
#
# Automatically finds the newest release folder under releases/, merges its
# command and question additions into commands.json and questions.json,
# validates the result, creates backups, commits the changes, and optionally
# pushes the commit to GitHub.
#
# Expected project layout:
#
#   ios-command-match-v2/
#   ├── commands.json
#   ├── questions.json
#   ├── merge-game-data.sh
#   └── releases/
#       ├── v1.4/
#       │   ├── commands-additions.json
#       │   └── questions-additions.json
#       └── v1.5/
#           ├── commands-additions.json
#           └── questions-additions.json
#
# Usage:
#
#   ./merge-game-data.sh
#
# Optional:
#
#   ./merge-game-data.sh "Expand game content to version 1.5"
#
# Requirements:
#
#   brew install jq
#
# Run the script from the root of the Git repository.

set -euo pipefail

ORIGINAL_COMMANDS="commands.json"
ORIGINAL_QUESTIONS="questions.json"
RELEASES_DIR="releases"
BACKUP_DIR="backups"

CUSTOM_COMMIT_MESSAGE="${1:-}"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
TEMP_DIR="$(mktemp -d)"
MERGED_COMMANDS="${TEMP_DIR}/commands-merged.json"
MERGED_QUESTIONS="${TEMP_DIR}/questions-merged.json"

cleanup() {
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

fail() {
    printf '\nERROR: %s\n' "$1" >&2
    exit 1
}

pass() {
    printf 'PASS: %s\n' "$1"
}

section() {
    printf '\n============================================================\n'
    printf '%s\n' "$1"
    printf '============================================================\n'
}

confirm() {
    local prompt="$1"
    local reply

    while true; do
        printf '%s [y/N]: ' "$prompt"
        read -r reply

        case "$reply" in
            y|Y|yes|YES|Yes)
                return 0
                ;;
            n|N|no|NO|No|"")
                return 1
                ;;
            *)
                printf 'Please enter y or n.\n'
                ;;
        esac
    done
}

section "Preflight checks"

command -v jq >/dev/null 2>&1 ||
    fail "jq is not installed. Install it with: brew install jq"
pass "jq is installed"

command -v git >/dev/null 2>&1 ||
    fail "Git is not installed."
pass "Git is installed"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
    fail "Run this script from inside the Git repository."
pass "Current directory is inside a Git repository"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
pass "Repository root: $REPO_ROOT"

[[ -f "$ORIGINAL_COMMANDS" ]] ||
    fail "Could not find $ORIGINAL_COMMANDS in the repository root."

[[ -f "$ORIGINAL_QUESTIONS" ]] ||
    fail "Could not find $ORIGINAL_QUESTIONS in the repository root."

[[ -d "$RELEASES_DIR" ]] ||
    fail "Could not find the $RELEASES_DIR directory."

section "Find newest release"

LATEST_RELEASE="$(
    find "$RELEASES_DIR" \
        -mindepth 1 \
        -maxdepth 1 \
        -type d \
        -exec basename {} \; |
    sort -V |
    tail -n 1
)"

[[ -n "$LATEST_RELEASE" ]] ||
    fail "No release folders were found inside $RELEASES_DIR."

RELEASE_PATH="${RELEASES_DIR}/${LATEST_RELEASE}"
NEW_COMMANDS="${RELEASE_PATH}/commands-additions.json"
NEW_QUESTIONS="${RELEASE_PATH}/questions-additions.json"

printf 'Newest release: %s\n' "$LATEST_RELEASE"
printf 'Commands file:  %s\n' "$NEW_COMMANDS"
printf 'Questions file: %s\n' "$NEW_QUESTIONS"

[[ -f "$NEW_COMMANDS" ]] ||
    fail "The newest release does not contain commands-additions.json."

[[ -f "$NEW_QUESTIONS" ]] ||
    fail "The newest release does not contain questions-additions.json."

if [[ -n "$CUSTOM_COMMIT_MESSAGE" ]]; then
    COMMIT_MESSAGE="$CUSTOM_COMMIT_MESSAGE"
else
    COMMIT_MESSAGE="Merge IOS command game data from ${LATEST_RELEASE}"
fi

section "Validate source files"

for file in \
    "$ORIGINAL_COMMANDS" \
    "$ORIGINAL_QUESTIONS" \
    "$NEW_COMMANDS" \
    "$NEW_QUESTIONS"
do
    jq empty "$file" >/dev/null 2>&1 ||
        fail "Invalid JSON: $file"

    [[ "$(jq -r 'type' "$file")" == "array" ]] ||
        fail "$file must contain a top-level JSON array."

    pass "$file is a valid JSON array"
done

existing_command_count="$(jq length "$ORIGINAL_COMMANDS")"
new_command_count="$(jq length "$NEW_COMMANDS")"
existing_question_count="$(jq length "$ORIGINAL_QUESTIONS")"
new_question_count="$(jq length "$NEW_QUESTIONS")"

[[ "$new_command_count" -gt 0 ]] ||
    fail "The new commands file is empty."

[[ "$new_question_count" -gt 0 ]] ||
    fail "The new questions file is empty."

printf '\nExisting commands:  %s\n' "$existing_command_count"
printf 'New commands:       %s\n' "$new_command_count"
printf 'Existing questions: %s\n' "$existing_question_count"
printf 'New questions:      %s\n' "$new_question_count"

section "Validate command additions"

missing_command_fields="$(
    jq -r '
        to_entries[]
        | select(
            (.value.id // "") == "" or
            (.value.command // "") == "" or
            (.value.purpose // "") == "" or
            (.value.syntax // "") == "" or
            (.value.difficulty // "") == "" or
            (.value.category // "") == "" or
            (.value.examWeight == null)
        )
        | (.key + 1)
    ' "$NEW_COMMANDS"
)"

[[ -z "$missing_command_fields" ]] ||
    fail "New command records are missing required fields at positions: $missing_command_fields"
pass "All new command records contain the required fields"

duplicate_new_command_ids="$(
    jq -r '
        group_by(.id)[]
        | select(length > 1)
        | .[0].id
    ' "$NEW_COMMANDS"
)"

[[ -z "$duplicate_new_command_ids" ]] ||
    fail "Duplicate command IDs in additions: $duplicate_new_command_ids"
pass "No duplicate command IDs exist within the additions"

duplicate_new_command_text="$(
    jq -r '
        group_by(.command | ascii_downcase)[]
        | select(length > 1)
        | .[0].command
    ' "$NEW_COMMANDS"
)"

[[ -z "$duplicate_new_command_text" ]] ||
    fail "Duplicate command strings in additions: $duplicate_new_command_text"
pass "No duplicate command strings exist within the additions"

conflicting_command_ids="$(
    jq -n \
        --slurpfile existing "$ORIGINAL_COMMANDS" \
        --slurpfile incoming "$NEW_COMMANDS" '
            ($existing[0] | map(.id)) as $existing_ids
            | $incoming[0][]
            | select(.id as $id | $existing_ids | index($id))
            | .id
        ' -r
)"

[[ -z "$conflicting_command_ids" ]] ||
    fail "New command IDs conflict with existing IDs: $conflicting_command_ids"
pass "New command IDs do not conflict with existing IDs"

conflicting_command_text="$(
    jq -n \
        --slurpfile existing "$ORIGINAL_COMMANDS" \
        --slurpfile incoming "$NEW_COMMANDS" '
            ($existing[0] | map(.command | ascii_downcase)) as $existing_commands
            | $incoming[0][]
            | select(
                (.command | ascii_downcase) as $cmd
                | $existing_commands
                | index($cmd)
            )
            | .command
        ' -r
)"

[[ -z "$conflicting_command_text" ]] ||
    fail "New commands duplicate existing command strings: $conflicting_command_text"
pass "No new command duplicates an existing command string"

section "Validate question additions"

missing_question_fields="$(
    jq -r '
        to_entries[]
        | select(
            (.value.id == null) or
            (.value.commandId // "") == "" or
            (.value.difficulty // "") == "" or
            (.value.cognitiveLevel // "") == "" or
            (.value.scenario // "") == "" or
            (.value.objective // "") == "" or
            (.value.explanation // "") == "" or
            (.value.answerCommand // "") == ""
        )
        | (.key + 1)
    ' "$NEW_QUESTIONS"
)"

[[ -z "$missing_question_fields" ]] ||
    fail "New question records are missing required fields at positions: $missing_question_fields"
pass "All new question records contain the required fields"

duplicate_new_question_ids="$(
    jq -r '
        group_by(.id)[]
        | select(length > 1)
        | .[0].id
    ' "$NEW_QUESTIONS"
)"

[[ -z "$duplicate_new_question_ids" ]] ||
    fail "Duplicate question IDs in additions: $duplicate_new_question_ids"
pass "No duplicate question IDs exist within the additions"

conflicting_question_ids="$(
    jq -n \
        --slurpfile existing "$ORIGINAL_QUESTIONS" \
        --slurpfile incoming "$NEW_QUESTIONS" '
            ($existing[0] | map(.id)) as $existing_ids
            | $incoming[0][]
            | select(.id as $id | $existing_ids | index($id))
            | .id
        ' -r
)"

[[ -z "$conflicting_question_ids" ]] ||
    fail "New question IDs conflict with existing IDs: $conflicting_question_ids"
pass "New question IDs do not conflict with existing IDs"

invalid_new_question_refs="$(
    jq -n \
        --slurpfile commands "$NEW_COMMANDS" \
        --slurpfile questions "$NEW_QUESTIONS" '
            ($commands[0] | map(.id)) as $command_ids
            | $questions[0][]
            | select(
                .commandId as $id
                | $command_ids
                | index($id)
                | not
            )
            | "\(.id) -> \(.commandId)"
        ' -r
)"

[[ -z "$invalid_new_question_refs" ]] ||
    fail "New questions reference commands not present in this release: $invalid_new_question_refs"
pass "Every new question references a command in the newest release"

wrong_question_counts="$(
    jq -n \
        --slurpfile commands "$NEW_COMMANDS" \
        --slurpfile questions "$NEW_QUESTIONS" '
            $commands[0][]
            | .id as $command_id
            | (
                $questions[0]
                | map(select(.commandId == $command_id))
                | length
            ) as $count
            | select($count != 5)
            | "\($command_id): \($count) questions"
        ' -r
)"

[[ -z "$wrong_question_counts" ]] ||
    fail "Each new command must have exactly five questions. Problems: $wrong_question_counts"
pass "Every new command has exactly five questions"

section "Create and validate merged files"

jq -s '.[0] + .[1]' \
    "$ORIGINAL_COMMANDS" \
    "$NEW_COMMANDS" \
    > "$MERGED_COMMANDS"

jq -s '.[0] + .[1]' \
    "$ORIGINAL_QUESTIONS" \
    "$NEW_QUESTIONS" \
    > "$MERGED_QUESTIONS"

jq empty "$MERGED_COMMANDS" >/dev/null 2>&1 ||
    fail "Merged commands file is invalid JSON."

jq empty "$MERGED_QUESTIONS" >/dev/null 2>&1 ||
    fail "Merged questions file is invalid JSON."

pass "Merged files are valid JSON"

expected_command_count=$((existing_command_count + new_command_count))
expected_question_count=$((existing_question_count + new_question_count))

actual_command_count="$(jq length "$MERGED_COMMANDS")"
actual_question_count="$(jq length "$MERGED_QUESTIONS")"

[[ "$actual_command_count" -eq "$expected_command_count" ]] ||
    fail "Merged command count is $actual_command_count; expected $expected_command_count."

[[ "$actual_question_count" -eq "$expected_question_count" ]] ||
    fail "Merged question count is $actual_question_count; expected $expected_question_count."

pass "Merged record counts are correct"

merged_duplicate_command_ids="$(
    jq -r '
        group_by(.id)[]
        | select(length > 1)
        | .[0].id
    ' "$MERGED_COMMANDS"
)"

[[ -z "$merged_duplicate_command_ids" ]] ||
    fail "Merged commands contain duplicate IDs: $merged_duplicate_command_ids"
pass "Merged commands contain no duplicate IDs"

merged_duplicate_command_text="$(
    jq -r '
        group_by(.command | ascii_downcase)[]
        | select(length > 1)
        | .[0].command
    ' "$MERGED_COMMANDS"
)"

[[ -z "$merged_duplicate_command_text" ]] ||
    fail "Merged commands contain duplicate command strings: $merged_duplicate_command_text"
pass "Merged commands contain no duplicate command strings"

merged_duplicate_question_ids="$(
    jq -r '
        group_by(.id)[]
        | select(length > 1)
        | .[0].id
    ' "$MERGED_QUESTIONS"
)"

[[ -z "$merged_duplicate_question_ids" ]] ||
    fail "Merged questions contain duplicate IDs: $merged_duplicate_question_ids"
pass "Merged questions contain no duplicate IDs"

invalid_merged_refs="$(
    jq -n \
        --slurpfile commands "$MERGED_COMMANDS" \
        --slurpfile questions "$MERGED_QUESTIONS" '
            ($commands[0] | map(.id)) as $command_ids
            | $questions[0][]
            | select(
                .commandId as $id
                | $command_ids
                | index($id)
                | not
            )
            | "\(.id) -> \(.commandId)"
        ' -r
)"

[[ -z "$invalid_merged_refs" ]] ||
    fail "Merged questions contain invalid command references: $invalid_merged_refs"
pass "Every merged question references a valid command"

section "Review planned changes"

printf 'Release:   %s\n' "$LATEST_RELEASE"
printf 'Commands:  %s -> %s\n' "$existing_command_count" "$actual_command_count"
printf 'Questions: %s -> %s\n' "$existing_question_count" "$actual_question_count"
printf 'Commit:    %s\n' "$COMMIT_MESSAGE"

if ! confirm "Proceed with backups, file replacement, and Git commit?"; then
    printf '\nCanceled. No project files were changed.\n'
    exit 0
fi

section "Create backups and install merged files"

mkdir -p "$BACKUP_DIR"

COMMANDS_BACKUP="${BACKUP_DIR}/commands-${TIMESTAMP}.json"
QUESTIONS_BACKUP="${BACKUP_DIR}/questions-${TIMESTAMP}.json"

cp "$ORIGINAL_COMMANDS" "$COMMANDS_BACKUP"
cp "$ORIGINAL_QUESTIONS" "$QUESTIONS_BACKUP"

pass "Created backup: $COMMANDS_BACKUP"
pass "Created backup: $QUESTIONS_BACKUP"

mv "$MERGED_COMMANDS" "$ORIGINAL_COMMANDS"
mv "$MERGED_QUESTIONS" "$ORIGINAL_QUESTIONS"

pass "Installed the validated commands.json"
pass "Installed the validated questions.json"

section "Create Git commit"

git add \
    "$ORIGINAL_COMMANDS" \
    "$ORIGINAL_QUESTIONS" \
    "$COMMANDS_BACKUP" \
    "$QUESTIONS_BACKUP" \
    "$RELEASE_PATH"

if git diff --cached --quiet; then
    fail "No Git changes were staged. Nothing was committed."
fi

git commit -m "$COMMIT_MESSAGE"
pass "Created the local Git commit"

section "Completed successfully"

printf 'Release:   %s\n' "$LATEST_RELEASE"
printf 'Commands:  %s -> %s\n' "$existing_command_count" "$actual_command_count"
printf 'Questions: %s -> %s\n' "$existing_question_count" "$actual_question_count"
printf 'Commit:    %s\n' "$COMMIT_MESSAGE"

printf '\n'

if confirm "Push this commit to GitHub now?"; then
    git push
    pass "Pushed the commit to GitHub"
else
    printf '\nThe commit remains stored locally.\n'
    printf 'When ready, upload it with:\n\n'
    printf '  git push\n\n'
fi
