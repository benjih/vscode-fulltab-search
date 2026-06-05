.PHONY: install lint test build package

install:
	npm install

lint: install
	npm run lint

test: build
	npm test

build: install
	npm run compile

package: build
	npm run package
