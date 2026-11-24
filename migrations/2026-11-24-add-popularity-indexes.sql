-- Recommendations rank genre matches by popularity with a LIMIT; with this
-- index MySQL reads in order and stops early instead of sorting the whole
-- provider catalog.
ALTER TABLE movie_streams  ADD INDEX ix_movie_streams_provider_popularity (provider_id, tmdb_popularity);
ALTER TABLE series_streams ADD INDEX ix_series_streams_provider_popularity (provider_id, tmdb_popularity);
-- TMDB-similar hits are looked up by tmdb_id (was a full provider scan).
ALTER TABLE movie_streams  ADD INDEX ix_movie_streams_provider_tmdb (provider_id, tmdb_id);
ALTER TABLE series_streams ADD INDEX ix_series_streams_provider_tmdb (provider_id, tmdb_id);
