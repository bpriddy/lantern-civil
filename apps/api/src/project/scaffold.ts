/**
 * What "add Civil to this project" writes.
 *
 * Initialising is not a manifest edit — there is no manifest yet — so it does not go
 * through the op layer. It creates files, as pending changes, so the scaffold can be
 * reviewed and committed like anything else rather than appearing in the repository
 * unannounced.
 *
 * The templates carry comments deliberately. PRD 6.5 keeps comments through every
 * edit, and a scaffold that explains itself is the first thing that proves it.
 */

export interface ScaffoldFile {
  path: string;
  content: string;
}

/** PRD 6.4: ids are lowercase, digits, hyphens and underscores, starting with a letter. */
function toId(name: string): string {
  const id = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return /^[a-z]/.test(id) ? id.slice(0, 64) : `project-${id}`.slice(0, 64);
}

export function scaffoldFiles(projectName: string): ScaffoldFile[] {
  const id = toId(projectName);

  return [
    {
      path: 'civil.yaml',
      content: `apiVersion: civil/v1
kind: Project
metadata:
  id: ${id}
  name: ${projectName}
spec:
  # The composition canvas: the top level of this project.
  composition: app.yaml
  language: python
`,
    },
    {
      path: 'app.yaml',
      content: `apiVersion: civil/v1
kind: Composition
metadata:
  id: ${id}
  name: ${projectName}

# The composition canvas. Three node types live here — clients, services and
# processes — and edges mean depends-on or routes-to, never dataflow.
spec:
  nodes: []
  edges: []

# Layout is a sibling of spec, never inside it, so moving a node never produces a
# diff that looks like a change to what the application is.
layout:
  nodes: {}
`,
    },
    {
      path: 'CIVIL.md',
      content: `# ${projectName}

What this project is, in your own words.

## What it does

Describe the application. This document is for the people who work on it — including
the ones who arrive later and need to know why it is shaped the way it is.

## How it is arranged

The composition canvas holds clients, services and processes. Services that are
interesting enough to be graphs descend into a dataflow canvas; the rest are
functions.

## Decisions worth remembering

Record the choices that were not obvious, and why they were made. The code says what
the project does; this says why.
`,
    },
  ];
}
