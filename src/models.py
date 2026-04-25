from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
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
