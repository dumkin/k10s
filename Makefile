# k10s tasks. Works with the stock macOS make (GNU Make 3.81).
#
#   make dev       run the app with hot reload (UI via Vite HMR, Rust rebuilt on change)
#   make build     optimized release build of every bundle (.app, .dmg) into target/release/bundle
#   make install   build the .app and install it into /Applications
#                  (another location: make install INSTALL_DIR=~/Applications)
#   make clean     remove build output, dependencies and OS junk (the next build starts from scratch)

APP_NAME    := k10s
INSTALL_DIR ?= /Applications
# zsh passes `INSTALL_DIR=~/Applications` with a literal "~"; expand it here.
INSTALL_TO  := $(patsubst ~%,$(HOME)%,$(INSTALL_DIR))
APP_BUNDLE  := target/release/bundle/macos/$(APP_NAME).app
DEPS        := ui/node_modules/.package-lock.json
# The Tauri CLI comes with the UI's npm dependencies; ui/package.json's `tauri` script runs it from the repository
# root, where it finds both the app (crates/k10s-app) and the UI (ui).
TAURI       := npm --prefix ui run tauri --

.PHONY: dev build install clean

dev: $(DEPS)
	$(TAURI) dev

build: $(DEPS)
	$(TAURI) build

# Only the .app bundle: skips the .dmg step, which scripts Finder and is not needed to install.
install: $(DEPS)
ifneq ($(shell uname -s),Darwin)
	$(error make install supports macOS only; use `make build` and take a package from target/release/bundle)
endif
	$(TAURI) build --bundles app
	rm -rf "$(INSTALL_TO)/$(APP_NAME).app"
	ditto "$(APP_BUNDLE)" "$(INSTALL_TO)/$(APP_NAME).app"
	@echo "Installed $(INSTALL_TO)/$(APP_NAME).app"

# Everything .gitignore treats as junk. Editor settings (.idea/, .vscode/) are yours and stay.
clean:
	cargo clean
	rm -rf ui/node_modules ui/dist crates/k10s-app/gen/schemas
	@rmdir crates/k10s-app/gen 2>/dev/null || true
	find . -not -path "./.git/*" \( -name .DS_Store -o -name "*.tsbuildinfo" \) -type f -print -delete

# npm dependencies are (re)installed only when package.json or the lockfile change.
$(DEPS): ui/package.json ui/package-lock.json
	npm --prefix ui install
	@touch $@
