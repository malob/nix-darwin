"""Generate options-data.js with pre-rendered HTML descriptions.

Reads the nix-darwin options JSON produced by nixosOptionsDoc,
renders each option's description to HTML using nixos-render-docs,
and writes a JavaScript file exporting the data as OPTIONS_DATA.

ECOSYSTEM COUPLING:
  - Input: options.json from nixosOptionsDoc (nixpkgs lib/options.nix).
    Each option has: type, description (DocBook/CommonMark), default,
    example, declarations, readOnly, loc.
  - nixos-render-docs: Converts description markup to HTML. Produces
    class names like .itemizedlist, .orderedlist, .note, .warning,
    .xref, .link — these are styled by options-explorer.css.
  - Output: Passes all fields through to OPTIONS_DATA, replacing
    description with rendered HTML. The JS explorer consumes:
    type, description, default, example, declarations.

Post-processing of rendered HTML:
  - xref links: Adds data-option attribute so the JS can intercept
    clicks and navigate to the referenced option inline.
  - External links: Adds target="_blank" rel="noopener" so they
    open in a new tab instead of navigating away from the explorer.

This build-time rendering is deliberate: it avoids shipping a markdown
parser in the browser and ensures descriptions render identically to
the nixos-render-docs manual output.
"""

import json
import re
import sys

from nixos_render_docs.manual_structure import XrefTarget
from nixos_render_docs.options import HTMLConverter

options_path, output_path, revision = sys.argv[1:]

with open(options_path) as f:
    options = json.load(f)

# Build cross-reference targets so nixos-render-docs can resolve
# {option}`foo.bar` references into clickable links.
xref_targets = {}
for name in options:
    xref_targets[f"opt-{name}"] = XrefTarget(
        id=name,
        title_html=name,
        toc_html=None,
        title=name,
        path="",
        drop_target=True,
    )

converter = HTMLConverter(
    manpage_urls={},
    revision=revision,
    varlist_id="options",
    id_prefix="opt-",
    xref_targets=xref_targets,
)

for opt in options.values():
    desc = opt.get("description", "")
    if desc:
        html = converter._render(desc)
        html = re.sub(
            r'<a class="xref" href="#([^"]*)"[^>]*>',
            r'<a class="xref" href="#\1" data-option="\1">',
            html,
        )
        html = re.sub(
            r'<a class="link" href="([^"]*)"[^>]*>',
            r'<a class="link" href="\1" target="_blank" rel="noopener">',
            html,
        )
        opt["description"] = html

with open(output_path, "w") as o:
    o.write("const OPTIONS_DATA = ")
    json.dump(options, o)
    o.write(";\n")
