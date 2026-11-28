-- Big-spender watch: Candy (Solana) whale usernames from candy.io (2026-11-27, Trevor: "Use chrome and find them
-- on the candy site"). Method: for each unnamed Solana whale, fetch https://candy.io/collectibles/<mint> for up to
-- three cards the wallet bought and never resold, and read the server-rendered "Owned by @<username>". A name is
-- saved only when TWO of the wallet's cards show the same owner (30 of 59). Nine wallets showed a name on one card
-- only and are left NULL; twenty showed none (cards listed or moved). Some usernames own two wallets (e.g. tadtweets,
-- thekandyman) — both are labelled. Keys are case-sensitive base58 and are matched exactly.
-- refresh_big_spender_wallets keeps these: its upsert is coalesce(EXCLUDED.username, w.username) and no
-- wallet_usernames row exists for a Solana key.
-- Revert: UPDATE public.big_spender_wallets SET username = NULL WHERE chain = 'solana' AND wallet_key IN (<the keys below>);
UPDATE public.big_spender_wallets w
   SET username = v.u, updated_at = now()
  FROM (VALUES
    ('2TXT6k37xQw2zj6t6CCJek68iLf1BZYRLSqVYPSyRH4T', 'kgarz31'),
    ('3HMtxmEfdqMgz5FmEow8JbQxET8jDNQ3uzoMyFm3kL8R', 'tadtweets'),
    ('EiWVtTQvUzMbcRwuyVPhLQKrjvbNUvFgBGmtTzsbjYB6', 'tadtweets'),
    ('3mthimVR3gLz6Jp45pDEEan1TgES5NzGjX1cD21Ue4L5', 'thekandyman'),
    ('D4yTxJWpnb9NxNGQAvRoApXN4GE5UAJ9zDTzUW5yR6YL', 'thekandyman'),
    ('3ncrEv5x2yG7KrjfU5m8n4brs8HR6sM4hbzBbh7oh8ca', 'yaozers3'),
    ('EoFhti9oQccv37gqmfWi1dvfUYkD7uWTjrBqdq8hzEjY', 'yaozers3'),
    ('4RFpDDQPjWi3hfNFXytup5VEZvKviWte7JpUNNWtF4Kq', 'cryptonian83'),
    ('6bFhUrWuvHm2vTLmEhJ19s7Q7GHDcYXqXa4hw9r7hCwD', 'frank1212'),
    ('6bkdjK9Hp7vLQZp3565GZGTMNhTBw4o3qjbqfCEvbqVJ', 'crashbooombang'),
    ('DatucLUcn4ggKzDhpcygx1vEG9uHU8Vf3L5vCxgEsf5h', 'crashbooombang'),
    ('7QE7s43XHVZzx39P8XYyEpAdSJwsrh4kK6qwrEhpKWqA', '69_superman_69'),
    ('7wXZeFyvzgddeFDb9csUXx54kRMh6nSUeEd4FSmFMZ7t', 'catchmeifyoucan'),
    ('888p4VSyDq2jNQszU8daRjg1tDsLBHjK21iXKsd4At6k', 'collector215'),
    ('9gVo1iJSS7YCYeV51WiYZu6JfFVjFuL2UgkGtpfVnLPE', 'atl'),
    ('9wzMobjTiCZUeZhL2ZZw15A33EwTCE1qZ3cV3w2NTZvC', 'lazarus1969'),
    ('A7kT7u2Tqp8ZWzGG7jTxbnF68H9rv9B5UymmkAeUH52o', 'adroldero'),
    ('AGzqZEJXbYeJze7aba6xTvQRHCt5ENmLhjbXejnzSpcQ', 'thunderking'),
    ('ArP9yefGqNMxwVFRGHMVP3YK4iy9zAtq2zbQQb8Vc5vW', 'thejimp'),
    ('BSDHcCACDiDZyAtEZJWw9t4yaMw41jz8ngu9KuPwktJp', 'Ai'),
    ('BdPpYNXLGreeNwhHosiiqL72Sqdh6iZACiCbHCcWQixB', 'majornft'),
    ('Bf6v98vH1hRFuWrfr4gAFjV2DFDnduic24MqZWEPUEJx', 'rormac'),
    ('GQ1YDnuuNPnjKuqmDWfkrDY8wr9nMraNnGY5PjeGcj8a', 'rormac'),
    ('CC5nSobJ4qdW7sDEfnDBhxffLXDK3MBX7q9Z3t7hxhN4', 'dsnook9218_on_discord'),
    ('DAXRK8qgVvkpwVbakcUW3mjWbgfNdRrbk1i5t1D9U17s', 'theperceptivision'),
    ('Fad3GzKDwDAa7vKsCt5KeB7mgBGaLTipqX54hNv7Po4E', 'theebiggestbro'),
    ('FjzzQ7yxv15xB2LwHbHnkqrYpqLJWLmUZvGubHf4QLi', 'amazing_banana_candy_4740'),
    ('FoJE7b2TEShYwCaDzQwTq8WAwB8K4aN4m3H25r2BfMLA', 'GritsnGravy'),
    ('Gk2AtJeRgz1RHvwM21SdTTN2MD5yyPzpuaDhVB6baAr3', 'cyber'),
    ('GwF6hCyZCH3o3VkfuHmaUtovWhk4Ut2VrXbZf4RECeGN', 'maximus44')
  ) v(k, u)
 WHERE w.wallet_key = v.k AND w.chain = 'solana' AND w.username IS NULL;
