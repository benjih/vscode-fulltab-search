.PHONY: install lint test test-unit test-integration test-ui build package demo-gif

install:
	npm install

lint: install
	npm run lint

test: test-unit test-integration

test-unit: install
	npm run test:unit

test-integration: build
	npm run test:integration

test-ui: build
	EXTENSIONS_FOLDER=.test-extensions EXTENSION_DEV_PATH=$(CURDIR) npm run test:ui

build: install
	npm run compile

package: build
	npm run package

# env -u: a shell spawned from inside VS Code inherits ELECTRON_RUN_AS_NODE,
# which makes the extest-launched VS Code run as plain Node and exit instantly.
demo-gif: build
	env -u ELECTRON_RUN_AS_NODE EXTENSIONS_FOLDER=.test-extensions EXTENSION_DEV_PATH=$(CURDIR) npm run demo:record
