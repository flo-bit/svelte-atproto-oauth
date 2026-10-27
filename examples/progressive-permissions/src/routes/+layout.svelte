<script lang="ts">
  let { children } = $props();
</script>
<main>
  <nav><a href="/">Server flow</a> · <a href="/browser">Browser flow</a></nav>
  {@render children()}
</main>
<style>
  :global(body) { font-family: system-ui, sans-serif; color: #172033; background: #f5f7fb; margin: 0; }
  main { max-width: 880px; margin: auto; padding: 2rem; }
  :global(section) { background: white; border: 1px solid #d8deea; padding: 1rem; margin-block: 1rem; border-radius: 8px; }
  :global(pre) { overflow: auto; background: #edf1f7; padding: 1rem; }
  :global(button), :global(input) { font: inherit; margin: .3rem; padding: .4rem; }
  :global(label) { display: block; overflow-wrap: anywhere; }
  :global(button) { cursor: pointer; }
</style>
