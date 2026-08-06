# __PACKAGE__

Standalone npm distribution of the Pi AI coding agent CLI from
[__REPO__](https://github.com/__REPO__), a fork of
[earendil-works/pi](https://github.com/earendil-works/pi). Provides the `pi` command
with per-platform standalone binaries.

## Install

```sh
npm install -g __PACKAGE__
```

If you previously installed the upstream CLI, remove it first because both packages
provide the `pi` binary:

```sh
npm uninstall -g @earendil-works/pi-coding-agent
```

## Update

```sh
npm update -g __PACKAGE__
```

## Usage

```sh
pi --help
pi --version
pi -p "your prompt"
```