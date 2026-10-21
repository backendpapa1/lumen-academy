-- ADR-009: School accents move from the neon palette to the illustrated one (same order).
UPDATE `schools` SET `accent_color` = CASE upper(`accent_color`)
  WHEN '#FFB547' THEN '#B86E00'
  WHEN '#FF6B6B' THEN '#D93A26'
  WHEN '#A78BFA' THEN '#6B4EFF'
  WHEN '#22D3EE' THEN '#0A7FB0'
  WHEN '#A3E635' THEN '#2F8A2F'
  WHEN '#2DD4BF' THEN '#0E8A80'
  WHEN '#94A3B8' THEN '#5B6488'
  WHEN '#F472B6' THEN '#C2338A'
  ELSE `accent_color` END;
