SHELL = /bin/bash

REGISTRY ?= ghcr.io
IMAGE_NAME ?= mkoziy/ralpix
IMAGE_REF := $(REGISTRY)/$(IMAGE_NAME)
PLATFORMS ?= linux/amd64,linux/arm64
BUILDER_NAME ?= ralpix-release
GHCR_USERNAME ?=

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
	for cmd in git docker gh npm; do \
		if ! command -v "$$cmd" >/dev/null 2>&1; then \
			echo "Missing required command: $$cmd" >&2; \
			exit 1; \
		fi; \
	done; \
	docker buildx version >/dev/null; \
	github_user="$(GHCR_USERNAME)"; \
	if [[ -z "$$github_user" ]]; then \
		github_user="$$(gh api user --jq .login)"; \
	fi; \
	if [[ -z "$$github_user" ]]; then \
		echo "Unable to resolve GitHub username for GHCR login" >&2; \
		exit 1; \
	fi; \
	gh auth token | docker login "$(REGISTRY)" -u "$$github_user" --password-stdin >/dev/null; \
	if ! docker buildx use "$(BUILDER_NAME)" >/dev/null 2>&1; then \
		docker buildx create --name "$(BUILDER_NAME)" --driver docker-container --use >/dev/null; \
	fi; \
	builder_driver="$$(docker buildx inspect "$(BUILDER_NAME)" --format '{{.Driver}}')"; \
	if [[ "$$builder_driver" != "docker-container" ]]; then \
		docker buildx rm "$(BUILDER_NAME)" >/dev/null 2>&1 || true; \
		docker buildx create --name "$(BUILDER_NAME)" --driver docker-container --use >/dev/null; \
	fi; \
	docker buildx inspect --bootstrap >/dev/null; \
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
	tags=(-t "$(IMAGE_REF):$$version"); \
	published_tags=("$(IMAGE_REF):$$version"); \
	prerelease_flag=(); \
	if [[ "$$version" =~ - ]]; then \
		prerelease_flag=(--prerelease); \
	else \
		minor_tag="$${version%.*}"; \
		tags+=(-t "$(IMAGE_REF):$$minor_tag" -t "$(IMAGE_REF):latest"); \
		published_tags+=("$(IMAGE_REF):$$minor_tag" "$(IMAGE_REF):latest"); \
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
		echo "## Published Images"; \
		for tag in "$${published_tags[@]}"; do \
			echo "- $$tag"; \
		done; \
		echo; \
		echo "## Platforms"; \
		echo "- $(PLATFORMS)"; \
		echo; \
		echo "## Commits"; \
		cat "$$commit_list_file"; \
	} > "$$release_notes_file"; \
	git tag -a "$$version" -m "Release $$version"; \
	docker buildx build \
		--platform "$(PLATFORMS)" \
		--push \
		"$${tags[@]}" \
		.; \
	git push origin "$$version"; \
	gh release create "$$version" \
		--title "$$version" \
		"$${prerelease_flag[@]}" \
		--notes-file "$$release_notes_file"
