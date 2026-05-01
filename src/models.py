from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Table,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship

from .database import Base


class XtreamProvider(Base):
    __tablename__ = "xtream_providers"

    id = Column(Integer, primary_key=True, autoincrement=True)
    base_url = Column(String(512), nullable=False, unique=True)
    fingerprint = Column(String(64), nullable=True, unique=True)
    fingerprint_sample = Column(JSON, nullable=True)
    france_news_sample = Column(JSON, nullable=True)
    name = Column(String(255), nullable=True)
    timezone = Column(String(100), nullable=True)
    is_populated = Column(Boolean, default=False, nullable=False)
    last_refreshed_at = Column(DateTime, nullable=True)
    last_synced_at = Column(DateTime, nullable=True)
    sync_started_at = Column(DateTime, nullable=True)
    active_master_user_id = Column(Integer, ForeignKey("iptv_users.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    users = relationship(
        "IPTVUser",
        back_populates="provider",
        foreign_keys="IPTVUser.provider_id",
    )
    live_categories = relationship(
        "LiveCategory", back_populates="provider", cascade="all, delete-orphan",
    )
    movie_categories = relationship(
        "MovieCategory", back_populates="provider", cascade="all, delete-orphan",
    )
    serie_categories = relationship(
        "SerieCategory", back_populates="provider", cascade="all, delete-orphan",
    )
    live_streams = relationship(
        "LiveStream", back_populates="provider", cascade="all, delete-orphan",
    )
    movie_streams = relationship(
        "MovieStream", back_populates="provider", cascade="all, delete-orphan",
    )
    series_streams = relationship(
        "SeriesStream", back_populates="provider", cascade="all, delete-orphan",
    )


class IPTVUser(Base):
    __tablename__ = "iptv_users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(255), nullable=False, unique=True)
    password = Column(String(255), nullable=False)
    base_url = Column(String(512), nullable=False)
    base_stream_url = Column(String(512), nullable=True)
    provider_id = Column(Integer, ForeignKey("xtream_providers.id"), nullable=True)

    status = Column(String(50), nullable=True)
    auth = Column(Boolean, nullable=True)
    is_trial = Column(Boolean, nullable=True)
    max_connections = Column(Integer, nullable=True)
    active_cons = Column(Integer, default=0)
    allowed_output_formats = Column(JSON, nullable=True)
    message = Column(Text, nullable=True)
    provider_created_at = Column(DateTime, nullable=True)
    provider_exp_date = Column(DateTime, nullable=True)
    subscription_exp_date = Column(DateTime, nullable=True)
    subscription_enforced = Column(Boolean, default=False, nullable=False)
    admin_note = Column(Text, nullable=True)

    port = Column(Integer, nullable=True)
    https_port = Column(Integer, nullable=True)
    server_protocol = Column(String(10), nullable=True)
    rtmp_port = Column(Integer, nullable=True)
    timezone = Column(String(100), nullable=True)
    provider_timestamp = Column(BigInteger, nullable=True)

    device_type = Column(String(20), nullable=True)
    preferred_output = Column(String(10), default="m3u8")
    is_active = Column(Boolean, default=True)
    is_connected = Column(Boolean, default=False)
    stream_count = Column(Integer, nullable=True)
    last_checked_at = Column(DateTime, nullable=True)
    last_login_at = Column(DateTime, nullable=True)

    last_heartbeat_at = Column(DateTime, nullable=True)
    last_activity_at = Column(DateTime, nullable=True)
    heartbeat_state = Column(String(20), nullable=True)
    app_visibility = Column(String(20), nullable=True)
    is_streaming = Column(Boolean, default=False, nullable=False)
    current_stream_kind = Column(String(20), nullable=True)
    current_stream_ref = Column(String(255), nullable=True)
    current_stream_url = Column(Text, nullable=True)
    current_stream_started_at = Column(DateTime, nullable=True)
    last_stream_url = Column(Text, nullable=True)
    last_stream_used_at = Column(DateTime, nullable=True)
    last_heartbeat_payload = Column(JSON, nullable=True)

    allocation_in_use = Column(Boolean, default=False, nullable=False)
    allocation_locked_by_user_id = Column(Integer, ForeignKey("iptv_users.id"), nullable=True)
    allocation_lock_token = Column(String(128), nullable=True)
    allocation_locked_at = Column(DateTime, nullable=True)
    allocation_lock_expires_at = Column(DateTime, nullable=True)
    allocation_last_released_at = Column(DateTime, nullable=True)

    reseller_line_id = Column(Integer, nullable=True, index=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        Index("ix_iptv_users_provider_allocation_in_use", "provider_id", "allocation_in_use"),
        Index("ix_iptv_users_allocation_lock_expires_at", "allocation_lock_expires_at"),
        Index("ix_iptv_users_is_streaming", "is_streaming"),
        Index("ix_iptv_users_last_heartbeat_at", "last_heartbeat_at"),
    )

    provider = relationship(
        "XtreamProvider",
        back_populates="users",
        foreign_keys=[provider_id],
    )


class LiveCategory(Base):
    __tablename__ = "live_categories"

    id = Column(Integer, primary_key=True, autoincrement=True)
    provider_id = Column(Integer, ForeignKey("xtream_providers.id"), nullable=False)
    parent_id = Column(Integer, ForeignKey("live_categories.id"), nullable=True)
    category_name = Column(String(255), nullable=False)
    category_id = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    provider = relationship("XtreamProvider", back_populates="live_categories")
    parent = relationship("LiveCategory", remote_side="LiveCategory.id", back_populates="children")
    children = relationship("LiveCategory", back_populates="parent", cascade="all, delete-orphan")
    live_streams = relationship("LiveStream", back_populates="live_category")


class MovieCategory(Base):
    __tablename__ = "movie_categories"

    id = Column(Integer, primary_key=True, autoincrement=True)
    provider_id = Column(Integer, ForeignKey("xtream_providers.id"), nullable=False)
    language = Column(String(10), nullable=True)
    category_name = Column(String(255), nullable=False)
    category_id = Column(Integer, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("provider_id", "category_id", name="uq_movie_category_provider_id"),
    )

    provider = relationship("XtreamProvider", back_populates="movie_categories")
    movie_streams = relationship("MovieStream", back_populates="movie_category")


class SerieCategory(Base):
    __tablename__ = "serie_categories"

    id = Column(Integer, primary_key=True, autoincrement=True)
    provider_id = Column(Integer, ForeignKey("xtream_providers.id"), nullable=False)
    language = Column(String(10), nullable=True)
    category_name = Column(String(255), nullable=False)
    category_id = Column(Integer, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("provider_id", "category_id", name="uq_serie_category_provider_id"),
    )

    provider = relationship("XtreamProvider", back_populates="serie_categories")
    series_streams = relationship("SeriesStream", back_populates="serie_category")


class LiveStream(Base):
    __tablename__ = "live_streams"

    id = Column(Integer, primary_key=True, autoincrement=True)
    provider_id = Column(Integer, ForeignKey("xtream_providers.id"), nullable=False)
    stream_id = Column(Integer, nullable=False)
    xtream_live_id = Column(Integer, nullable=True)
    name = Column(String(512), nullable=False)
    raw_name = Column(String(512), nullable=True)
    stream_type = Column(String(20), default="live")
    stream_icon = Column(String(1024), nullable=True)
    epg_channel_id = Column(String(255), nullable=True)
    added = Column(DateTime, nullable=True)
    category_id = Column(Integer, nullable=True)
    live_category_id = Column(Integer, ForeignKey("live_categories.id"), nullable=True)
    custom_sid = Column(String(255), nullable=True)
    tv_archive = Column(Boolean, default=False)
    tv_archive_duration = Column(Integer, default=0)
    direct_source = Column(String(1024), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("provider_id", "stream_id", name="uq_live_stream_provider_stream"),
    )

    provider = relationship("XtreamProvider", back_populates="live_streams")
    live_category = relationship("LiveCategory", back_populates="live_streams")


movie_stream_genre_association = Table(
    "movie_stream_genres",
    Base.metadata,
    Column("movie_stream_id", Integer, ForeignKey("movie_streams.id"), primary_key=True),
    Column("genre_id", Integer, ForeignKey("tmdb_genres.id"), primary_key=True),
)


series_stream_genre_association = Table(
    "series_stream_genres",
    Base.metadata,
    Column("series_stream_id", Integer, ForeignKey("series_streams.id"), primary_key=True),
    Column("genre_id", Integer, ForeignKey("tmdb_genres.id"), primary_key=True),
)


class TMDBGenre(Base):
    __tablename__ = "tmdb_genres"

    id = Column(Integer, primary_key=True, autoincrement=True)
    tmdb_genre_id = Column(Integer, unique=True, nullable=True)
    name = Column(String(100), unique=True, nullable=False)

    movie_streams = relationship(
        "MovieStream", secondary=movie_stream_genre_association, back_populates="genres",
    )
    series_streams = relationship(
        "SeriesStream", secondary=series_stream_genre_association, back_populates="genres",
    )


class MovieStream(Base):
    __tablename__ = "movie_streams"

    id = Column(Integer, primary_key=True, autoincrement=True)
    provider_id = Column(Integer, ForeignKey("xtream_providers.id"), nullable=False)
    xtream_id = Column(Integer, nullable=False)
    num = Column(Integer, nullable=True)
    raw_name = Column(String(512), nullable=True)
    language = Column(String(10), nullable=True)
    name = Column(String(512), nullable=False)
    year = Column(Integer, nullable=True)
    stream_type = Column(String(20), default="movie")
    stream_icon = Column(String(1024), nullable=True)
    rating = Column(String(20), nullable=True)
    rating_5based = Column(Float, nullable=True)
    added = Column(DateTime, nullable=True)
    category_id = Column(Integer, nullable=True)
    movie_category_id = Column(Integer, ForeignKey("movie_categories.id"), nullable=True)
    container_extension = Column(String(20), nullable=True)
    tmdb_id = Column(Integer, nullable=True)

    cover_big = Column(String(1024), nullable=True)
    releasedate = Column(Date, nullable=True)
    youtube_trailer = Column(String(100), nullable=True)
    backdrop_path = Column(String(1024), nullable=True)
    duration = Column(String(20), nullable=True)

    video_codec = Column(String(20), nullable=True)
    video_width = Column(Integer, nullable=True)
    video_height = Column(Integer, nullable=True)

    audio_codec = Column(String(20), nullable=True)
    audio_channels = Column(Integer, nullable=True)
    audio_channel_layout = Column(String(50), nullable=True)

    o_name = Column(String(512), nullable=True)
    description = Column(Text, nullable=True)
    actors = Column(Text, nullable=True)
    director = Column(Text, nullable=True)
    country = Column(String(100), nullable=True)
    age_rating = Column(String(20), nullable=True)
    bitrate = Column(Integer, nullable=True)
    duration_secs = Column(Integer, nullable=True)
    status = Column(String(20), nullable=True)
    genre_raw = Column(String(255), nullable=True)
    details_synced_at = Column(DateTime, nullable=True)

    tmdb_synced_at = Column(DateTime, nullable=True)
    o_language = Column(String(10), nullable=True)
    tmdb_vote_average = Column(Float, nullable=True)
    tmdb_popularity = Column(Float, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("provider_id", "xtream_id", name="uq_movie_stream_provider_xtream"),
        Index("ix_movie_streams_provider_language", "provider_id", "language"),
        Index("ix_movie_streams_provider_year", "provider_id", "year"),
        Index("ix_movie_streams_provider_name", "provider_id", "name"),
    )

    provider = relationship("XtreamProvider", back_populates="movie_streams")
    movie_category = relationship("MovieCategory", back_populates="movie_streams")
    genres = relationship(
        "TMDBGenre", secondary=movie_stream_genre_association, back_populates="movie_streams",
    )


class SeriesStream(Base):
    __tablename__ = "series_streams"

    id = Column(Integer, primary_key=True, autoincrement=True)
    provider_id = Column(Integer, ForeignKey("xtream_providers.id"), nullable=False)
    xtream_id = Column(Integer, nullable=False)

    num = Column(Integer, nullable=True)
    raw_name = Column(String(512), nullable=True)
    language = Column(String(10), nullable=True)
    name = Column(String(512), nullable=False)

    stream_type = Column(String(20), nullable=True)
    stream_icon = Column(String(1024), nullable=True)
    rating = Column(String(20), nullable=True)
    rating_5based = Column(Float, nullable=True)
    added = Column(DateTime, nullable=True)
    category_id = Column(Integer, nullable=True)
    series_category_id = Column(Integer, ForeignKey("serie_categories.id"), nullable=True)

    cover = Column(String(1024), nullable=True)
    backdrop_path = Column(String(1024), nullable=True)
    plot = Column(Text, nullable=True)
    cast = Column(Text, nullable=True)
    director = Column(String(512), nullable=True)
    release_date = Column(Date, nullable=True)
    last_modified = Column(DateTime, nullable=True)
    youtube_trailer = Column(String(100), nullable=True)
    episode_run_time = Column(Integer, nullable=True)
    tmdb_id = Column(Integer, nullable=True)

    o_name = Column(String(512), nullable=True)
    genre_raw = Column(String(255), nullable=True)

    episodes_last_synced_at = Column(DateTime, nullable=True)
    tmdb_synced_at = Column(DateTime, nullable=True)
    o_language = Column(String(10), nullable=True)
    tmdb_vote_average = Column(Float, nullable=True)
    tmdb_popularity = Column(Float, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("provider_id", "xtream_id", name="uq_series_stream_provider_xtream"),
        Index("ix_series_streams_provider_language", "provider_id", "language"),
        Index("ix_series_streams_provider_name", "provider_id", "name"),
    )

    provider = relationship("XtreamProvider", back_populates="series_streams")
    serie_category = relationship("SerieCategory", back_populates="series_streams")
    seasons = relationship(
        "SeriesSeason", back_populates="series",
        cascade="all, delete-orphan", order_by="SeriesSeason.season_number",
    )
    episodes = relationship(
        "SeriesEpisode", back_populates="series", cascade="all, delete-orphan",
    )
    genres = relationship(
        "TMDBGenre", secondary=series_stream_genre_association, back_populates="series_streams",
    )


class SeriesSeason(Base):
    __tablename__ = "series_seasons"

    id = Column(Integer, primary_key=True, autoincrement=True)
    series_id = Column(Integer, ForeignKey("series_streams.id"), nullable=False)
    provider_id = Column(Integer, ForeignKey("xtream_providers.id"), nullable=False)

    tmdb_season_id = Column(Integer, nullable=True)
    season_number = Column(Integer, nullable=False)
    name = Column(String(255), nullable=True)
    overview = Column(Text, nullable=True)
    air_date = Column(Date, nullable=True)
    episode_count = Column(Integer, nullable=True)
    vote_average = Column(Float, nullable=True)
    cover = Column(String(1024), nullable=True)
    cover_big = Column(String(1024), nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("series_id", "season_number", name="uq_series_season"),
        Index("ix_series_seasons_series_id", "series_id"),
    )

    series = relationship("SeriesStream", back_populates="seasons")
    episodes = relationship(
        "SeriesEpisode", back_populates="season",
        cascade="all, delete-orphan", order_by="SeriesEpisode.episode_num",
    )


class SeriesEpisode(Base):
    __tablename__ = "series_episodes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    series_id = Column(Integer, ForeignKey("series_streams.id"), nullable=False)
    season_id = Column(Integer, ForeignKey("series_seasons.id"), nullable=False)
    provider_id = Column(Integer, ForeignKey("xtream_providers.id"), nullable=False)

    xtream_id = Column(Integer, nullable=False)
    season_number = Column(Integer, nullable=False)
    episode_num = Column(Integer, nullable=False)

    raw_title = Column(String(512), nullable=True)
    title = Column(String(512), nullable=True)

    container_extension = Column(String(20), nullable=True)
    custom_sid = Column(String(255), nullable=True)
    direct_source = Column(String(1024), nullable=True)
    added = Column(DateTime, nullable=True)

    tmdb_id = Column(Integer, nullable=True)
    release_date = Column(Date, nullable=True)
    plot = Column(Text, nullable=True)
    movie_image = Column(String(1024), nullable=True)
    duration_secs = Column(Integer, nullable=True)
    rating = Column(String(20), nullable=True)

    video_codec = Column(String(20), nullable=True)
    video_width = Column(Integer, nullable=True)
    video_height = Column(Integer, nullable=True)

    audio_codec = Column(String(20), nullable=True)
    audio_channels = Column(Integer, nullable=True)
    audio_channel_layout = Column(String(50), nullable=True)
    audio_language = Column(String(10), nullable=True)

    bitrate = Column(Integer, nullable=True)
    frame_rate = Column(String(20), nullable=True)
    aspect_ratio = Column(String(10), nullable=True)
    crew = Column(Text, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("provider_id", "xtream_id", name="uq_series_episode_provider_xtream"),
        Index(
            "ix_series_episodes_series_season",
            "series_id", "season_number", "episode_num",
        ),
        Index("ix_series_episodes_provider_xtream", "provider_id", "xtream_id"),
    )

    series = relationship("SeriesStream", back_populates="episodes")
    season = relationship("SeriesSeason", back_populates="episodes")


class Subtitle(Base):
    __tablename__ = "subtitles"

    id = Column(Integer, primary_key=True, autoincrement=True)
    tmdb_id = Column(Integer, nullable=False, index=True)
    lang = Column(String(10), nullable=False)
    label = Column(String(100))
    season = Column(Integer, nullable=False, default=0)
    episode = Column(Integer, nullable=False, default=0)
    vtt_content = Column(Text(length=2**24 - 1))
    source_url = Column(String(500))
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint(
            "tmdb_id", "lang", "season", "episode",
            name="uq_subtitle_tmdb_lang_ep",
        ),
    )


# ---------------------------------------------------------------------------
# Sport events — Claude-curated upcoming live sport broadcasts.
# Populated by the periodic `sport-events` skill (see
# .claude/skills/sport-events/SKILL.md) and exposed via
# /api/v1/sport-events for the Home hero rail.
# ---------------------------------------------------------------------------

class SportEvent(Base):
    __tablename__ = "sport_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    batch_id = Column(Integer, nullable=False, index=True)

    title = Column(String(255), nullable=False)
    description = Column(Text)
    sport = Column(String(64), nullable=False)
    league = Column(String(128))
    home_team = Column(String(128))
    away_team = Column(String(128))

    start_utc = Column(DateTime, nullable=False, index=True)
    end_utc = Column(DateTime, nullable=False, index=True)

    # Denormalized "primary" broadcaster — kept for quick display when
    # we don't need the full list (admin views, run summaries, etc.).
    # The full list of broadcasters lives in SportEventBroadcaster.
    broadcaster_name = Column(String(128), nullable=False)
    broadcaster_country = Column(String(8))

    cover_url = Column(String(1024))
    source_url = Column(String(1024), nullable=False)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    broadcasters = relationship(
        "SportEventBroadcaster",
        back_populates="event",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class SportEventBroadcaster(Base):
    """One row per (event, broadcaster). Big sporting events typically
    air on different TV channels per country (Movistar+ in Spain,
    ESPN in the US, beIN in MENA, …); the read endpoint resolves each
    one against the requesting user's provider catalog and surfaces
    the resolved channels so the user can pick.
    """
    __tablename__ = "sport_event_broadcasters"

    id = Column(Integer, primary_key=True, autoincrement=True)
    event_id = Column(
        Integer,
        ForeignKey("sport_events.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    broadcaster_name = Column(String(128), nullable=False)
    country = Column(String(8))            # ISO 3166-1 alpha-2
    language = Column(String(8))           # ISO 639-1, optional
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("event_id", "broadcaster_name", "country",
                         name="uq_event_broadcaster_country"),
    )

    event = relationship("SportEvent", back_populates="broadcasters")


class LiveStreamAlias(Base):
    """Self-improving broadcaster→channel match cache.

    Populated by ingest.py when a fuzzy resolve succeeds; subsequent
    reads short-circuit to an exact lookup.
    """
    __tablename__ = "live_stream_aliases"

    id = Column(Integer, primary_key=True, autoincrement=True)
    provider_id = Column(Integer, ForeignKey("xtream_providers.id"), nullable=False)
    alias = Column(String(128), nullable=False)
    live_stream_id = Column(Integer, ForeignKey("live_streams.id"), nullable=False)
    confidence = Column(Float, default=1.0)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("provider_id", "alias", name="uq_alias_provider"),
        Index("ix_alias_provider_alias", "provider_id", "alias"),
    )


class SportEventsRun(Base):
    """One row per scheduler invocation; surfaces success/failure to the
    admin endpoint without parsing logs."""
    __tablename__ = "sport_events_runs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    started_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    finished_at = Column(DateTime)
    status = Column(String(32), default="running", nullable=False)
    triggered_by = Column(String(32), default="schedule")
    events_written = Column(Integer, default=0)
    error = Column(Text)


class KvSettings(Base):
    """Tiny generic key/value store. v1 use case: the
    `sport_events_current_batch` pointer; future callers welcome.
    """
    __tablename__ = "kv_settings"

    key = Column(String(64), primary_key=True)
    value = Column(Text, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
