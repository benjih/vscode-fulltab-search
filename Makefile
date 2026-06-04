.PHONY: install lint test build

install:
	npm install

lint: install
	npm run lint

test: build
	npm test

build: install
	npm run compile
