# pi-openrouter-metadata

Metadata refresh for Pi's built-in OpenRouter provider.

The extension keeps Pi's bundled OpenRouter models as an offline and compatibility baseline. It fetches OpenRouter's public catalog and overlays validated metadata for matching models, including names, context windows, output limits, reasoning levels, image input, and pricing.

Validated overlays are cached in `~/.config/pi/openrouter-metadata-store.json`. Network refreshes revalidate the cache after five minutes, while offline and failed refreshes retain the previous catalog.

This extension does not configure custom providers. Use `pi-custom-providers` and `/custom-providers` for that.
