# Security policy

k10s works with your cluster credentials. It reads your kubeconfig, runs the exec plugins it names and talks to API servers as you. Reports about its security come first.

## Reporting a vulnerability

Report it privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability** ([direct link](../../security/advisories/new)). Please don't open a public issue, discussion or pull request for it.

It helps to include:

- what an attacker can do, and under which conditions;
- steps to reproduce, or a proof of concept;
- your k10s version and operating system.

You'll hear back within a week. Once a fix is released, the advisory is published with credit to you, unless you'd rather stay anonymous.

## What is in scope

Anything that makes k10s act against its user when it is fed by something the user doesn't control:

- a cluster: object fields, events, log lines, terminal output, API responses;
- a kubeconfig, or the output of an exec plugin;
- anything shown in or loaded into the app's web view.

For example: running a command or reading a file on the user's machine, changing a cluster while read-only mode is on, getting past the confirmation of a destructive action, leaking credentials or Secret values to the log, to files or over the network, or getting k10s to install an update that wasn't signed by the project.

Out of scope:

- what someone who already controls your machine or your user account can do: k10s runs with your permissions and keeps its preferences in plain files;
- a cluster you deliberately connect to slowing k10s down by sheer volume;
- missing hardening without a demonstrated impact.

## Supported versions

Fixes go into the latest release. Copies installed from GitHub Releases, Homebrew or winget update themselves, so getting a fix takes a restart. Builds made from source don't: rebuild them from the latest tag.

## How updates are protected

The updater accepts only packages signed with the project's update key: k10s checks each signature against the public key built into it and refuses anything that doesn't verify. Each signature also names the version it was made for, and k10s refuses a package whose signed version differs from the one the feed announces: a changed feed can't pass an older release off as a new one. The check itself is an HTTPS request to GitHub Releases.
