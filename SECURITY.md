# Security

## Adapters are code

Every `*.js` file in the adapters folder (`<userData>/adapters`, or `STICKY_BRAIN_ADAPTERS`) is
loaded into the Electron main process at start-up with full Node access. An adapter can read and
write any file, and spawn any process, that your user account can. Only load adapters you trust
and have read. The board does not sandbox them.

## Reporting a vulnerability

Please report security issues privately to the maintainer (GitHub: *Security → Report a
vulnerability* on the repository) rather than in a public issue.
