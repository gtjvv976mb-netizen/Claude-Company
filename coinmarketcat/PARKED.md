# Parked here until its own repository exists

This directory is the complete tree of **CoinMarketCat**, the sniper cat by Cat
Intelligence Agency. It belongs in its own repository, `gtjvv976mb-netizen/coinmarketcat`,
which this session could not create. It is parked on this branch so the work survives.

To move it out, create the empty repository on GitHub, then:

```
cp -r coinmarketcat /tmp/coinmarketcat && cd /tmp/coinmarketcat && rm PARKED.md
git init -b main && git add -A && git commit -m "CoinMarketCat, by Cat Intelligence Agency"
git remote add origin https://github.com/gtjvv976mb-netizen/coinmarketcat.git && git push -u origin main
```

Then delete this directory from Claude-Company. Nothing in Claude-Company's build,
tests or deploys reads it.
