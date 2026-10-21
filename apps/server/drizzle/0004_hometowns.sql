-- ADR-009: a normal school. Students who enrolled from sci-fi homeworlds get real hometowns.
UPDATE `cadets` SET `homeworld` = CASE `homeworld`
  WHEN 'Titan Shipyards' THEN 'Lagos'
  WHEN 'Europa Deep' THEN 'Nairobi'
  WHEN 'Ceres Exchange' THEN 'São Paulo'
  WHEN 'Lagos Orbital' THEN 'Accra'
  WHEN 'Mars Commons' THEN 'Manchester'
  WHEN 'Ganymede Rings' THEN 'Seoul'
  WHEN 'Luna Arcology' THEN 'Lisbon'
  WHEN 'Callisto Reach' THEN 'Toronto'
  WHEN 'Vesta Foundry' THEN 'Mumbai'
  WHEN 'Io Relay' THEN 'Cairo'
  ELSE `homeworld` END;
