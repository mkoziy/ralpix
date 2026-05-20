SHELL = /bin/bash

.PHONY: release
release:
	@set -euo pipefail; \
	version="$(VERSION)"; \
	if [[ -z "$$version" ]]; then \
		echo "VERSION is required, e.g. make release VERSION=1.2.3" >&2; \
		exit 1; \
	fi; \
	if [[ ! "$$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$$ ]]; then \
		echo "VERSION must be plain semver like 1.2.3 or 1.2.3-rc1" >&2; \
		exit 1; \
	fi; \
	for cmd in git gh npm; do \
		if ! command -v "$$cmd" >/dev/null 2>&1; then \
			echo "Missing required command: $$cmd" >&2; \
			exit 1; \
		fi; \
	done; \
	if [[ -n "$$(git status --porcelain)" ]]; then \
		echo "Working tree must be clean before release" >&2; \
		exit 1; \
	fi; \
	if git rev-parse -q --verify "refs/tags/$$version" >/dev/null; then \
		echo "Tag already exists: $$version" >&2; \
		exit 1; \
	fi; \
	npm ci; \
	npm run check; \
	previous_tag="$$(git tag --sort=-version:refname | grep -E '^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$$' | head -n 1 || true)"; \
	commit_list_file="$$(mktemp)"; \
	release_notes_file="$$(mktemp)"; \
	trap 'rm -f "$$commit_list_file" "$$release_notes_file"' EXIT; \
	if [[ -n "$$previous_tag" ]]; then \
		commit_count="$$(git rev-list --count "$$previous_tag"..HEAD)"; \
		git log --format='- %h %s' "$$previous_tag"..HEAD > "$$commit_list_file"; \
	else \
		commit_count="$$(git rev-list --count HEAD)"; \
		git log --format='- %h %s' > "$$commit_list_file"; \
	fi; \
	if [[ ! -s "$$commit_list_file" ]]; then \
		echo "- No commits in release range" > "$$commit_list_file"; \
	fi; \
	is_prerelease=false; \
	if [[ "$$version" =~ - ]]; then \
		is_prerelease=true; \
	fi; \
	{ \
		echo "# $$version"; \
		echo; \
		if [[ -n "$$previous_tag" ]]; then \
			echo "$$commit_count commits since $$previous_tag."; \
		else \
			echo "$$commit_count commits since repository start."; \
		fi; \
		echo; \
		echo "## Commits"; \
		cat "$$commit_list_file"; \
	} > "$$release_notes_file"; \
	git tag -a "$$version" -m "Release $$version"; \
	git push origin "$$version"; \
	if [[ "$$is_prerelease" == "true" ]]; then \
		gh release create "$$version" \
			--title "$$version" \
			--prerelease \
			--notes-file "$$release_notes_file"; \
	else \
		gh release create "$$version" \
			--title "$$version" \
			--notes-file "$$release_notes_file"; \
	fi
