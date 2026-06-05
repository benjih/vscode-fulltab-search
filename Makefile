.PHONY: install lint test test-unit test-integration test-ui build package

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
