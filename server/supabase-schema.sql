-- ============================================================
-- MyImmoManagement - Schéma Supabase (référence)
-- Généré par pg_dump 17.6 depuis la base de développement
-- (docker exec supabase_db_MIM pg_dump --schema-only -n public).
-- Reflète l'état réel : tables, contraintes, index, RLS
-- (politiques + WITH CHECK), privilèges, triggers.
-- Pour appliquer : Supabase SQL Editor → New query (ou psql).
-- À régénérer après toute migration.
-- ============================================================

--
-- PostgreSQL database dump
--

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: pg_database_owner
--

CREATE SCHEMA public;


ALTER SCHEMA public OWNER TO pg_database_owner;

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: pg_database_owner
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    INSERT INTO public.profiles (id, account_type, name, email, phone, role, username, must_change_password)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'account_type', 'proprietaire'),
        COALESCE(NEW.raw_user_meta_data->>'name', ''),
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'phone', ''),
        COALESCE(NEW.raw_user_meta_data->>'role', 'proprietaire'),
        NULLIF(NEW.raw_user_meta_data->>'username', ''),
        COALESCE((NEW.raw_user_meta_data->>'must_change_password')::boolean, false)
    );
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: abonnement_paiements; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.abonnement_paiements (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    plan text NOT NULL,
    montant numeric(12,2) NOT NULL,
    date_paiement timestamp with time zone DEFAULT now(),
    methode_paiement text,
    reference text,
    date_debut timestamp with time zone DEFAULT now() NOT NULL,
    date_expiration timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT abonnement_paiements_methode_check CHECK (((methode_paiement IS NULL) OR (methode_paiement = ANY (ARRAY['especes'::text, 'mobile_money'::text, 'virement'::text, 'carte'::text, 'wave'::text, 'orange_money'::text]))))
);


ALTER TABLE public.abonnement_paiements OWNER TO postgres;

--
-- Name: abonnement_paiements_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.abonnement_paiements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.abonnement_paiements_id_seq OWNER TO postgres;

--
-- Name: abonnement_paiements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.abonnement_paiements_id_seq OWNED BY public.abonnement_paiements.id;


--
-- Name: announcements; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.announcements (
    id bigint NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    audience text DEFAULT 'all'::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    published_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT announcements_audience_check CHECK ((audience = ANY (ARRAY['all'::text, 'owners'::text, 'tenants'::text, 'employees'::text, 'admins'::text]))),
    CONSTRAINT announcements_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'archived'::text])))
);


ALTER TABLE public.announcements OWNER TO postgres;

--
-- Name: announcements_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.announcements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.announcements_id_seq OWNER TO postgres;

--
-- Name: announcements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.announcements_id_seq OWNED BY public.announcements.id;


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.audit_logs (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    action text NOT NULL,
    target_id text,
    target_type text,
    level text DEFAULT 'info'::text NOT NULL,
    meta jsonb,
    ip text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audit_logs_level_check CHECK ((level = ANY (ARRAY['info'::text, 'warn'::text, 'critical'::text])))
);


ALTER TABLE public.audit_logs OWNER TO postgres;

--
-- Name: audit_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.audit_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.audit_logs_id_seq OWNER TO postgres;

--
-- Name: audit_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.audit_logs_id_seq OWNED BY public.audit_logs.id;


--
-- Name: biens; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.biens (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    nom text NOT NULL,
    type text NOT NULL,
    adresse text,
    ville text,
    pays text,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.biens OWNER TO postgres;

--
-- Name: biens_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.biens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.biens_id_seq OWNER TO postgres;

--
-- Name: biens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.biens_id_seq OWNED BY public.biens.id;


--
-- Name: employes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.employes (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    account_uid uuid,
    username text,
    nom text NOT NULL,
    poste text,
    salaire numeric(12,2) DEFAULT 0 NOT NULL,
    email text,
    phone text,
    date_embauche date,
    statut text DEFAULT 'actif'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT employes_statut_check CHECK ((statut = ANY (ARRAY['actif'::text, 'inactif'::text])))
);


ALTER TABLE public.employes OWNER TO postgres;

--
-- Name: employes_biens; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.employes_biens (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    employe_id bigint NOT NULL,
    bien_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.employes_biens OWNER TO postgres;

--
-- Name: employes_biens_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.employes_biens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.employes_biens_id_seq OWNER TO postgres;

--
-- Name: employes_biens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.employes_biens_id_seq OWNED BY public.employes_biens.id;


--
-- Name: employes_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.employes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.employes_id_seq OWNER TO postgres;

--
-- Name: employes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.employes_id_seq OWNED BY public.employes.id;


--
-- Name: featured_items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.featured_items (
    id bigint NOT NULL,
    target_type text NOT NULL,
    target_id text NOT NULL,
    badge text,
    priority integer DEFAULT 0 NOT NULL,
    featured_until timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT featured_items_target_type_check CHECK ((target_type = ANY (ARRAY['user'::text, 'bien'::text, 'logement'::text, 'announcement'::text, 'event'::text])))
);


ALTER TABLE public.featured_items OWNER TO postgres;

--
-- Name: featured_items_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.featured_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.featured_items_id_seq OWNER TO postgres;

--
-- Name: featured_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.featured_items_id_seq OWNED BY public.featured_items.id;


--
-- Name: incidents; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.incidents (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    logement_id bigint,
    titre text NOT NULL,
    description text,
    statut text DEFAULT 'nouveau'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    photo text,
    resolved_by bigint,
    resolved_at timestamp with time zone,
    CONSTRAINT incidents_statut_check CHECK ((statut = ANY (ARRAY['nouveau'::text, 'en_cours'::text, 'intervention'::text, 'resolu'::text])))
);


ALTER TABLE public.incidents OWNER TO postgres;

--
-- Name: incidents_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.incidents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.incidents_id_seq OWNER TO postgres;

--
-- Name: incidents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.incidents_id_seq OWNED BY public.incidents.id;


--
-- Name: interventions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.interventions (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    incident_id bigint,
    prestataire_id bigint,
    logement_id bigint,
    titre text NOT NULL,
    description text,
    statut text DEFAULT 'planifie'::text NOT NULL,
    date_prevue date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT interventions_statut_check CHECK ((statut = ANY (ARRAY['planifie'::text, 'en_cours'::text, 'termine'::text])))
);


ALTER TABLE public.interventions OWNER TO postgres;

--
-- Name: interventions_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.interventions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.interventions_id_seq OWNER TO postgres;

--
-- Name: interventions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.interventions_id_seq OWNED BY public.interventions.id;


--
-- Name: locataires; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.locataires (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    account_uid uuid,
    logement_id bigint,
    nom text NOT NULL,
    email text,
    phone text,
    date_entree date,
    statut text DEFAULT 'actif'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    username text,
    jour_echeance integer DEFAULT 1,
    bien_id bigint,
    CONSTRAINT locataires_statut_check CHECK ((statut = ANY (ARRAY['actif'::text, 'inactif'::text])))
);


ALTER TABLE public.locataires OWNER TO postgres;

--
-- Name: locataires_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.locataires_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.locataires_id_seq OWNER TO postgres;

--
-- Name: locataires_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.locataires_id_seq OWNED BY public.locataires.id;


--
-- Name: logements; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.logements (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    bien_id bigint,
    nom text NOT NULL,
    loyer_mensuel numeric(12,2) DEFAULT 0 NOT NULL,
    statut text DEFAULT 'libre'::text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    type text,
    nombre_chambres integer,
    adresse text,
    CONSTRAINT logements_statut_check CHECK ((statut = ANY (ARRAY['libre'::text, 'occupe'::text, 'maintenance'::text]))),
    CONSTRAINT logements_type_check CHECK (((type IS NULL) OR (type = ANY (ARRAY['appartement'::text, 'chambre'::text]))))
);


ALTER TABLE public.logements OWNER TO postgres;

--
-- Name: logements_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.logements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.logements_id_seq OWNER TO postgres;

--
-- Name: logements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.logements_id_seq OWNED BY public.logements.id;


--
-- Name: moyens_paiement; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.moyens_paiement (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    type text NOT NULL,
    nom_titulaire text,
    numero text,
    lien_paiement text,
    banque text,
    num_compte text,
    iban text,
    bic text,
    instructions text,
    actif boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT moyens_paiement_type_check CHECK ((type = ANY (ARRAY['wave'::text, 'orange_money'::text, 'virement'::text, 'especes'::text])))
);


ALTER TABLE public.moyens_paiement OWNER TO postgres;

--
-- Name: moyens_paiement_employes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.moyens_paiement_employes (
    id bigint NOT NULL,
    employe_uid uuid NOT NULL,
    type text NOT NULL,
    nom_titulaire text,
    numero text,
    lien_paiement text,
    banque text,
    num_compte text,
    iban text,
    bic text,
    instructions text,
    actif boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT moyens_paiement_employes_type_check CHECK ((type = ANY (ARRAY['wave'::text, 'orange_money'::text, 'virement'::text, 'especes'::text])))
);


ALTER TABLE public.moyens_paiement_employes OWNER TO postgres;

--
-- Name: moyens_paiement_employes_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.moyens_paiement_employes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.moyens_paiement_employes_id_seq OWNER TO postgres;

--
-- Name: moyens_paiement_employes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.moyens_paiement_employes_id_seq OWNED BY public.moyens_paiement_employes.id;


--
-- Name: moyens_paiement_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.moyens_paiement_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.moyens_paiement_id_seq OWNER TO postgres;

--
-- Name: moyens_paiement_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.moyens_paiement_id_seq OWNED BY public.moyens_paiement.id;


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.notifications (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    type text NOT NULL,
    message text NOT NULL,
    lu boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.notifications OWNER TO postgres;

--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.notifications_id_seq OWNER TO postgres;

--
-- Name: notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;


--
-- Name: paiements; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.paiements (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    locataire_id bigint,
    logement_id bigint,
    montant numeric(12,2) NOT NULL,
    mois text NOT NULL,
    statut text DEFAULT 'attente'::text NOT NULL,
    date_paiement date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    methode_paiement text,
    reference text,
    validation_requested_at timestamp with time zone,
    validated_at timestamp with time zone,
    validated_by uuid,
    rejection_reason text,
    CONSTRAINT paiements_methode_check CHECK (((methode_paiement IS NULL) OR (methode_paiement = ANY (ARRAY['especes'::text, 'mobile_money'::text, 'virement'::text, 'carte'::text, 'wave'::text, 'orange_money'::text])))),
    CONSTRAINT paiements_statut_check CHECK ((statut = ANY (ARRAY['attente'::text, 'paye'::text, 'retard'::text, 'a_confirmer'::text, 'en_validation'::text, 'refuse'::text])))
);


ALTER TABLE public.paiements OWNER TO postgres;

--
-- Name: paiements_employes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.paiements_employes (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    employe_id bigint,
    employe_uid uuid,
    montant numeric(12,2) NOT NULL,
    mois text NOT NULL,
    statut text DEFAULT 'attente'::text NOT NULL,
    date_paiement date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    methode_paiement text,
    reference text,
    confirmed_at timestamp with time zone,
    confirmed_by uuid,
    rejected_at timestamp with time zone,
    rejection_reason text,
    moyen_employe_id bigint,
    CONSTRAINT paiements_employes_methode_check CHECK (((methode_paiement IS NULL) OR (methode_paiement = ANY (ARRAY['especes'::text, 'mobile_money'::text, 'virement'::text, 'carte'::text, 'wave'::text, 'orange_money'::text])))),
    CONSTRAINT paiements_employes_statut_check CHECK ((statut = ANY (ARRAY['paye'::text, 'attente'::text, 'non_recu'::text])))
);


ALTER TABLE public.paiements_employes OWNER TO postgres;

--
-- Name: paiements_employes_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.paiements_employes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.paiements_employes_id_seq OWNER TO postgres;

--
-- Name: paiements_employes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.paiements_employes_id_seq OWNED BY public.paiements_employes.id;


--
-- Name: paiements_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.paiements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.paiements_id_seq OWNER TO postgres;

--
-- Name: paiements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.paiements_id_seq OWNED BY public.paiements.id;


--
-- Name: platform_events; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.platform_events (
    id bigint NOT NULL,
    title text NOT NULL,
    description text,
    event_date timestamp with time zone NOT NULL,
    audience text DEFAULT 'all'::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_events_audience_check CHECK ((audience = ANY (ARRAY['all'::text, 'owners'::text, 'tenants'::text, 'employees'::text, 'admins'::text]))),
    CONSTRAINT platform_events_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'cancelled'::text])))
);


ALTER TABLE public.platform_events OWNER TO postgres;

--
-- Name: platform_events_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.platform_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.platform_events_id_seq OWNER TO postgres;

--
-- Name: platform_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.platform_events_id_seq OWNED BY public.platform_events.id;


--
-- Name: prestataires; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.prestataires (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    nom text NOT NULL,
    specialite text,
    phone text,
    email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.prestataires OWNER TO postgres;

--
-- Name: prestataires_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.prestataires_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.prestataires_id_seq OWNER TO postgres;

--
-- Name: prestataires_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.prestataires_id_seq OWNED BY public.prestataires.id;


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    account_type text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    phone text NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    username text,
    must_change_password boolean DEFAULT false NOT NULL,
    avatar_url text,
    CONSTRAINT profiles_account_type_check CHECK ((account_type = ANY (ARRAY['proprietaire'::text, 'agence'::text, 'entreprise'::text, 'locataire'::text, 'admin'::text, 'employe'::text, 'ultra_admin'::text])))
);


ALTER TABLE public.profiles OWNER TO postgres;

--
-- Name: sessions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.sessions (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    action text NOT NULL,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    logout_at timestamp with time zone
);


ALTER TABLE public.sessions OWNER TO postgres;

--
-- Name: sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.sessions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.sessions_id_seq OWNER TO postgres;

--
-- Name: sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.sessions_id_seq OWNED BY public.sessions.id;


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    plan text DEFAULT 'standard'::text NOT NULL,
    statut text DEFAULT 'actif'::text NOT NULL,
    date_debut timestamp with time zone DEFAULT now() NOT NULL,
    date_expiration timestamp with time zone NOT NULL,
    date_paiement timestamp with time zone,
    montant numeric(12,2),
    methode_paiement text,
    reference text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscriptions_statut_check CHECK ((statut = ANY (ARRAY['actif'::text, 'expire'::text])))
);


ALTER TABLE public.subscriptions OWNER TO postgres;

--
-- Name: system_config; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.system_config (
    key text NOT NULL,
    value text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.system_config OWNER TO postgres;

--
-- Name: tasks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tasks (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    employe_uid uuid,
    titre text NOT NULL,
    description text,
    statut text DEFAULT 'a_faire'::text NOT NULL,
    echeance date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tasks_statut_check CHECK ((statut = ANY (ARRAY['a_faire'::text, 'en_cours'::text, 'termine'::text])))
);


ALTER TABLE public.tasks OWNER TO postgres;

--
-- Name: tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.tasks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.tasks_id_seq OWNER TO postgres;

--
-- Name: tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.tasks_id_seq OWNED BY public.tasks.id;


--
-- Name: abonnement_paiements id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.abonnement_paiements ALTER COLUMN id SET DEFAULT nextval('public.abonnement_paiements_id_seq'::regclass);


--
-- Name: announcements id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.announcements ALTER COLUMN id SET DEFAULT nextval('public.announcements_id_seq'::regclass);


--
-- Name: audit_logs id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_logs ALTER COLUMN id SET DEFAULT nextval('public.audit_logs_id_seq'::regclass);


--
-- Name: biens id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.biens ALTER COLUMN id SET DEFAULT nextval('public.biens_id_seq'::regclass);


--
-- Name: employes id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employes ALTER COLUMN id SET DEFAULT nextval('public.employes_id_seq'::regclass);


--
-- Name: employes_biens id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employes_biens ALTER COLUMN id SET DEFAULT nextval('public.employes_biens_id_seq'::regclass);


--
-- Name: featured_items id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.featured_items ALTER COLUMN id SET DEFAULT nextval('public.featured_items_id_seq'::regclass);


--
-- Name: incidents id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.incidents ALTER COLUMN id SET DEFAULT nextval('public.incidents_id_seq'::regclass);


--
-- Name: interventions id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.interventions ALTER COLUMN id SET DEFAULT nextval('public.interventions_id_seq'::regclass);


--
-- Name: locataires id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.locataires ALTER COLUMN id SET DEFAULT nextval('public.locataires_id_seq'::regclass);


--
-- Name: logements id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.logements ALTER COLUMN id SET DEFAULT nextval('public.logements_id_seq'::regclass);


--
-- Name: moyens_paiement id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.moyens_paiement ALTER COLUMN id SET DEFAULT nextval('public.moyens_paiement_id_seq'::regclass);


--
-- Name: moyens_paiement_employes id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.moyens_paiement_employes ALTER COLUMN id SET DEFAULT nextval('public.moyens_paiement_employes_id_seq'::regclass);


--
-- Name: notifications id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);


--
-- Name: paiements id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements ALTER COLUMN id SET DEFAULT nextval('public.paiements_id_seq'::regclass);


--
-- Name: paiements_employes id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements_employes ALTER COLUMN id SET DEFAULT nextval('public.paiements_employes_id_seq'::regclass);


--
-- Name: platform_events id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.platform_events ALTER COLUMN id SET DEFAULT nextval('public.platform_events_id_seq'::regclass);


--
-- Name: prestataires id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.prestataires ALTER COLUMN id SET DEFAULT nextval('public.prestataires_id_seq'::regclass);


--
-- Name: sessions id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sessions ALTER COLUMN id SET DEFAULT nextval('public.sessions_id_seq'::regclass);


--
-- Name: tasks id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tasks ALTER COLUMN id SET DEFAULT nextval('public.tasks_id_seq'::regclass);


--
-- Name: abonnement_paiements abonnement_paiements_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.abonnement_paiements
    ADD CONSTRAINT abonnement_paiements_pkey PRIMARY KEY (id);


--
-- Name: announcements announcements_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: biens biens_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.biens
    ADD CONSTRAINT biens_pkey PRIMARY KEY (id);


--
-- Name: employes_biens employes_biens_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employes_biens
    ADD CONSTRAINT employes_biens_pkey PRIMARY KEY (id);


--
-- Name: employes_biens employes_biens_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employes_biens
    ADD CONSTRAINT employes_biens_unique UNIQUE (employe_id, bien_id);


--
-- Name: employes employes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employes
    ADD CONSTRAINT employes_pkey PRIMARY KEY (id);


--
-- Name: featured_items featured_items_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.featured_items
    ADD CONSTRAINT featured_items_pkey PRIMARY KEY (id);


--
-- Name: incidents incidents_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT incidents_pkey PRIMARY KEY (id);


--
-- Name: interventions interventions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.interventions
    ADD CONSTRAINT interventions_pkey PRIMARY KEY (id);


--
-- Name: locataires locataires_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.locataires
    ADD CONSTRAINT locataires_pkey PRIMARY KEY (id);


--
-- Name: logements logements_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.logements
    ADD CONSTRAINT logements_pkey PRIMARY KEY (id);


--
-- Name: moyens_paiement_employes moyens_paiement_employes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.moyens_paiement_employes
    ADD CONSTRAINT moyens_paiement_employes_pkey PRIMARY KEY (id);


--
-- Name: moyens_paiement moyens_paiement_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.moyens_paiement
    ADD CONSTRAINT moyens_paiement_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: paiements_employes paiements_employes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements_employes
    ADD CONSTRAINT paiements_employes_pkey PRIMARY KEY (id);


--
-- Name: paiements paiements_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements
    ADD CONSTRAINT paiements_pkey PRIMARY KEY (id);


--
-- Name: platform_events platform_events_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.platform_events
    ADD CONSTRAINT platform_events_pkey PRIMARY KEY (id);


--
-- Name: prestataires prestataires_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.prestataires
    ADD CONSTRAINT prestataires_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_email_key UNIQUE (email);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_user_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_user_unique UNIQUE (user_id);


--
-- Name: system_config system_config_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.system_config
    ADD CONSTRAINT system_config_pkey PRIMARY KEY (key);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: idx_announcements_audience; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_announcements_audience ON public.announcements USING btree (audience);


--
-- Name: idx_announcements_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_announcements_status ON public.announcements USING btree (status);


--
-- Name: idx_audit_logs_action; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_logs_action ON public.audit_logs USING btree (action);


--
-- Name: idx_audit_logs_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_logs_created_at ON public.audit_logs USING btree (created_at DESC);


--
-- Name: idx_audit_logs_level; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_logs_level ON public.audit_logs USING btree (level);


--
-- Name: idx_audit_logs_user_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_logs_user_id ON public.audit_logs USING btree (user_id);


--
-- Name: idx_featured_items_priority; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_featured_items_priority ON public.featured_items USING btree (priority DESC);


--
-- Name: idx_featured_items_target; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_featured_items_target ON public.featured_items USING btree (target_type, target_id);


--
-- Name: idx_moyens_paiement_employes_uid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_moyens_paiement_employes_uid ON public.moyens_paiement_employes USING btree (employe_uid);


--
-- Name: idx_platform_events_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_platform_events_date ON public.platform_events USING btree (event_date);


--
-- Name: idx_platform_events_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_platform_events_status ON public.platform_events USING btree (status);


--
-- Name: profiles_username_uniq; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX profiles_username_uniq ON public.profiles USING btree (username) WHERE (username IS NOT NULL);


--
-- Name: abonnement_paiements abonnement_paiements_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.abonnement_paiements
    ADD CONSTRAINT abonnement_paiements_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: announcements announcements_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: audit_logs audit_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: biens biens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.biens
    ADD CONSTRAINT biens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: employes employes_account_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employes
    ADD CONSTRAINT employes_account_uid_fkey FOREIGN KEY (account_uid) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: employes_biens employes_biens_bien_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employes_biens
    ADD CONSTRAINT employes_biens_bien_id_fkey FOREIGN KEY (bien_id) REFERENCES public.biens(id) ON DELETE CASCADE;


--
-- Name: employes_biens employes_biens_employe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employes_biens
    ADD CONSTRAINT employes_biens_employe_id_fkey FOREIGN KEY (employe_id) REFERENCES public.employes(id) ON DELETE CASCADE;


--
-- Name: employes_biens employes_biens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employes_biens
    ADD CONSTRAINT employes_biens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: employes employes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employes
    ADD CONSTRAINT employes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: featured_items featured_items_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.featured_items
    ADD CONSTRAINT featured_items_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: incidents incidents_logement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT incidents_logement_id_fkey FOREIGN KEY (logement_id) REFERENCES public.logements(id) ON DELETE SET NULL;


--
-- Name: incidents incidents_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT incidents_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.employes(id) ON DELETE SET NULL;


--
-- Name: incidents incidents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT incidents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: interventions interventions_incident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.interventions
    ADD CONSTRAINT interventions_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES public.incidents(id) ON DELETE SET NULL;


--
-- Name: interventions interventions_logement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.interventions
    ADD CONSTRAINT interventions_logement_id_fkey FOREIGN KEY (logement_id) REFERENCES public.logements(id) ON DELETE SET NULL;


--
-- Name: interventions interventions_prestataire_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.interventions
    ADD CONSTRAINT interventions_prestataire_id_fkey FOREIGN KEY (prestataire_id) REFERENCES public.prestataires(id) ON DELETE SET NULL;


--
-- Name: interventions interventions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.interventions
    ADD CONSTRAINT interventions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: locataires locataires_account_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.locataires
    ADD CONSTRAINT locataires_account_uid_fkey FOREIGN KEY (account_uid) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: locataires locataires_bien_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.locataires
    ADD CONSTRAINT locataires_bien_id_fkey FOREIGN KEY (bien_id) REFERENCES public.biens(id) ON DELETE SET NULL;


--
-- Name: locataires locataires_logement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.locataires
    ADD CONSTRAINT locataires_logement_id_fkey FOREIGN KEY (logement_id) REFERENCES public.logements(id) ON DELETE SET NULL;


--
-- Name: locataires locataires_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.locataires
    ADD CONSTRAINT locataires_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: logements logements_bien_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.logements
    ADD CONSTRAINT logements_bien_id_fkey FOREIGN KEY (bien_id) REFERENCES public.biens(id) ON DELETE SET NULL;


--
-- Name: logements logements_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.logements
    ADD CONSTRAINT logements_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: moyens_paiement_employes moyens_paiement_employes_employe_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.moyens_paiement_employes
    ADD CONSTRAINT moyens_paiement_employes_employe_uid_fkey FOREIGN KEY (employe_uid) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: moyens_paiement moyens_paiement_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.moyens_paiement
    ADD CONSTRAINT moyens_paiement_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: paiements_employes paiements_employes_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements_employes
    ADD CONSTRAINT paiements_employes_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: paiements_employes paiements_employes_employe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements_employes
    ADD CONSTRAINT paiements_employes_employe_id_fkey FOREIGN KEY (employe_id) REFERENCES public.employes(id) ON DELETE CASCADE;


--
-- Name: paiements_employes paiements_employes_employe_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements_employes
    ADD CONSTRAINT paiements_employes_employe_uid_fkey FOREIGN KEY (employe_uid) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: paiements_employes paiements_employes_moyen_employe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements_employes
    ADD CONSTRAINT paiements_employes_moyen_employe_id_fkey FOREIGN KEY (moyen_employe_id) REFERENCES public.moyens_paiement_employes(id) ON DELETE SET NULL;


--
-- Name: paiements_employes paiements_employes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements_employes
    ADD CONSTRAINT paiements_employes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: paiements paiements_locataire_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements
    ADD CONSTRAINT paiements_locataire_id_fkey FOREIGN KEY (locataire_id) REFERENCES public.locataires(id) ON DELETE CASCADE;


--
-- Name: paiements paiements_logement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements
    ADD CONSTRAINT paiements_logement_id_fkey FOREIGN KEY (logement_id) REFERENCES public.logements(id) ON DELETE SET NULL;


--
-- Name: paiements paiements_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements
    ADD CONSTRAINT paiements_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: paiements paiements_validated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paiements
    ADD CONSTRAINT paiements_validated_by_fkey FOREIGN KEY (validated_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: platform_events platform_events_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.platform_events
    ADD CONSTRAINT platform_events_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: prestataires prestataires_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.prestataires
    ADD CONSTRAINT prestataires_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_employe_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_employe_uid_fkey FOREIGN KEY (employe_uid) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: abonnement_paiements; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.abonnement_paiements ENABLE ROW LEVEL SECURITY;

--
-- Name: announcements admin_read_announcements; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY admin_read_announcements ON public.announcements FOR SELECT TO authenticated USING (((status = 'published'::text) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.account_type = ANY (ARRAY['admin'::text, 'ultra_admin'::text])))))));


--
-- Name: audit_logs admin_read_audit_logs; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY admin_read_audit_logs ON public.audit_logs FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.account_type = ANY (ARRAY['admin'::text, 'ultra_admin'::text]))))));


--
-- Name: platform_events admin_read_events; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY admin_read_events ON public.platform_events FOR SELECT TO authenticated USING (((status = 'published'::text) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.account_type = ANY (ARRAY['admin'::text, 'ultra_admin'::text])))))));


--
-- Name: announcements; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_logs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: biens; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.biens ENABLE ROW LEVEL SECURITY;

--
-- Name: moyens_paiement_employes employe_all_own_moyens; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY employe_all_own_moyens ON public.moyens_paiement_employes USING ((employe_uid = auth.uid())) WITH CHECK ((employe_uid = auth.uid()));


--
-- Name: biens employe_select_biens_affectes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY employe_select_biens_affectes ON public.biens FOR SELECT USING ((EXISTS ( SELECT 1
   FROM (public.employes_biens eb
     JOIN public.employes e ON ((e.id = eb.employe_id)))
  WHERE ((e.account_uid = auth.uid()) AND (eb.bien_id = biens.id)))));


--
-- Name: incidents employe_select_incidents_affectes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY employe_select_incidents_affectes ON public.incidents FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ((public.logements lg
     JOIN public.employes_biens eb ON ((eb.bien_id = lg.bien_id)))
     JOIN public.employes e ON ((e.id = eb.employe_id)))
  WHERE ((lg.id = incidents.logement_id) AND (e.account_uid = auth.uid())))));


--
-- Name: interventions employe_select_interventions_affectes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY employe_select_interventions_affectes ON public.interventions FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ((public.logements lg
     JOIN public.employes_biens eb ON ((eb.bien_id = lg.bien_id)))
     JOIN public.employes e ON ((e.id = eb.employe_id)))
  WHERE ((lg.id = interventions.logement_id) AND (e.account_uid = auth.uid())))));


--
-- Name: locataires employe_select_locataires_affectes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY employe_select_locataires_affectes ON public.locataires FOR SELECT USING ((EXISTS ( SELECT 1
   FROM (public.employes_biens eb
     JOIN public.employes e ON ((e.id = eb.employe_id)))
  WHERE ((e.account_uid = auth.uid()) AND (eb.bien_id = locataires.bien_id)))));


--
-- Name: logements employe_select_logements_affectes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY employe_select_logements_affectes ON public.logements FOR SELECT USING ((EXISTS ( SELECT 1
   FROM (public.employes_biens eb
     JOIN public.employes e ON ((e.id = eb.employe_id)))
  WHERE ((e.account_uid = auth.uid()) AND (eb.bien_id = logements.bien_id)))));


--
-- Name: employes employe_select_own_employe; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY employe_select_own_employe ON public.employes FOR SELECT USING ((account_uid = auth.uid()));


--
-- Name: employes_biens employe_select_own_employes_biens; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY employe_select_own_employes_biens ON public.employes_biens FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.employes e
  WHERE ((e.account_uid = auth.uid()) AND (e.id = employes_biens.employe_id)))));


--
-- Name: paiements_employes employe_select_own_paiements; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY employe_select_own_paiements ON public.paiements_employes FOR SELECT USING ((employe_uid = auth.uid()));


--
-- Name: tasks employe_select_own_tasks; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY employe_select_own_tasks ON public.tasks FOR SELECT USING ((employe_uid = auth.uid()));


--
-- Name: paiements_employes employe_update_own_paiements; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY employe_update_own_paiements ON public.paiements_employes FOR UPDATE USING ((employe_uid = auth.uid())) WITH CHECK ((employe_uid = auth.uid()));


--
-- Name: employes; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.employes ENABLE ROW LEVEL SECURITY;

--
-- Name: employes_biens; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.employes_biens ENABLE ROW LEVEL SECURITY;

--
-- Name: featured_items; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.featured_items ENABLE ROW LEVEL SECURITY;

--
-- Name: incidents; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;

--
-- Name: interventions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.interventions ENABLE ROW LEVEL SECURITY;

--
-- Name: locataires; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.locataires ENABLE ROW LEVEL SECURITY;

--
-- Name: logements; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.logements ENABLE ROW LEVEL SECURITY;

--
-- Name: moyens_paiement; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.moyens_paiement ENABLE ROW LEVEL SECURITY;

--
-- Name: moyens_paiement_employes; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.moyens_paiement_employes ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: biens owner_all_biens; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_biens ON public.biens USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: employes owner_all_employes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_employes ON public.employes USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: employes_biens owner_all_employes_biens; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_employes_biens ON public.employes_biens USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: incidents owner_all_incidents; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_incidents ON public.incidents USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: interventions owner_all_interventions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_interventions ON public.interventions USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: locataires owner_all_locataires; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_locataires ON public.locataires USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: logements owner_all_logements; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_logements ON public.logements USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: moyens_paiement owner_all_moyens_paiement; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_moyens_paiement ON public.moyens_paiement USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: notifications owner_all_notifications; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_notifications ON public.notifications USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: paiements owner_all_paiements; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_paiements ON public.paiements USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: paiements_employes owner_all_paiements_employes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_paiements_employes ON public.paiements_employes USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: prestataires owner_all_prestataires; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_prestataires ON public.prestataires USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: sessions owner_all_sessions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_sessions ON public.sessions USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: tasks owner_all_tasks; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_all_tasks ON public.tasks USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: moyens_paiement_employes owner_select_employe_moyens; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_select_employe_moyens ON public.moyens_paiement_employes FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.employes e
  WHERE ((e.account_uid = moyens_paiement_employes.employe_uid) AND (e.user_id = auth.uid())))));


--
-- Name: abonnement_paiements owner_select_own_abonnement_paiements; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_select_own_abonnement_paiements ON public.abonnement_paiements FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: subscriptions owner_select_own_subscription; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY owner_select_own_subscription ON public.subscriptions FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: paiements; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.paiements ENABLE ROW LEVEL SECURITY;

--
-- Name: paiements_employes; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.paiements_employes ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_events; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.platform_events ENABLE ROW LEVEL SECURITY;

--
-- Name: prestataires; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.prestataires ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: featured_items public_read_featured; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY public_read_featured ON public.featured_items FOR SELECT USING (true);


--
-- Name: sessions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: subscriptions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: system_config; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY;

--
-- Name: tasks; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: incidents tenant_insert_incident; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY tenant_insert_incident ON public.incidents FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM (public.locataires l
     JOIN public.logements lg ON ((lg.id = l.logement_id)))
  WHERE ((l.account_uid = auth.uid()) AND (lg.id = incidents.logement_id) AND (lg.user_id = incidents.user_id)))));


--
-- Name: locataires tenant_link_locataire; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY tenant_link_locataire ON public.locataires FOR UPDATE USING ((((lower(email) = lower((auth.jwt() ->> 'email'::text))) OR (split_part(lower((auth.jwt() ->> 'email'::text)), '@'::text, 1) = lower(username))) AND (account_uid IS NULL))) WITH CHECK ((account_uid = auth.uid()));


--
-- Name: biens tenant_select_bien; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY tenant_select_bien ON public.biens FOR SELECT USING ((EXISTS ( SELECT 1
   FROM (public.logements lg
     JOIN public.locataires l ON ((l.logement_id = lg.id)))
  WHERE ((lg.bien_id = biens.id) AND (l.account_uid = auth.uid())))));


--
-- Name: locataires tenant_select_by_email; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY tenant_select_by_email ON public.locataires FOR SELECT USING (((lower(email) = lower((auth.jwt() ->> 'email'::text))) OR (split_part(lower((auth.jwt() ->> 'email'::text)), '@'::text, 1) = lower(username))));


--
-- Name: incidents tenant_select_incident; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY tenant_select_incident ON public.incidents FOR SELECT USING ((EXISTS ( SELECT 1
   FROM (public.logements lg
     JOIN public.locataires l ON ((l.logement_id = lg.id)))
  WHERE ((lg.id = incidents.logement_id) AND (l.account_uid = auth.uid())))));


--
-- Name: locataires tenant_select_locataire; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY tenant_select_locataire ON public.locataires FOR SELECT USING ((account_uid = auth.uid()));


--
-- Name: logements tenant_select_logement; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY tenant_select_logement ON public.logements FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.locataires l
  WHERE ((l.account_uid = auth.uid()) AND (l.logement_id = logements.id)))));


--
-- Name: moyens_paiement tenant_select_moyens_paiement; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY tenant_select_moyens_paiement ON public.moyens_paiement FOR SELECT USING (((actif = true) AND (EXISTS ( SELECT 1
   FROM (public.locataires l
     JOIN public.logements lg ON ((lg.id = l.logement_id)))
  WHERE ((l.account_uid = auth.uid()) AND (lg.user_id = moyens_paiement.user_id))))));


--
-- Name: paiements tenant_select_paiement; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY tenant_select_paiement ON public.paiements FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.locataires l
  WHERE ((l.account_uid = auth.uid()) AND (l.id = paiements.locataire_id)))));


--
-- Name: announcements ultra_admin_all_announcements; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY ultra_admin_all_announcements ON public.announcements TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.account_type = 'ultra_admin'::text)))));


--
-- Name: platform_events ultra_admin_all_events; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY ultra_admin_all_events ON public.platform_events TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.account_type = 'ultra_admin'::text)))));


--
-- Name: featured_items ultra_admin_all_featured; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY ultra_admin_all_featured ON public.featured_items TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.account_type = 'ultra_admin'::text)))));


--
-- Name: system_config ultra_admin_all_system_config; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY ultra_admin_all_system_config ON public.system_config TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.account_type = 'ultra_admin'::text)))));


--
-- Name: profiles users_can_update_own; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY users_can_update_own ON public.profiles FOR UPDATE USING ((auth.uid() = id)) WITH CHECK ((auth.uid() = id));


--
-- Name: profiles users_can_view_own; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY users_can_view_own ON public.profiles FOR SELECT USING ((auth.uid() = id));


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION handle_new_user(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.handle_new_user() TO authenticated;
GRANT ALL ON FUNCTION public.handle_new_user() TO service_role;


--
-- Name: TABLE abonnement_paiements; Type: ACL; Schema: public; Owner: postgres
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.abonnement_paiements TO anon;
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.abonnement_paiements TO authenticated;
GRANT ALL ON TABLE public.abonnement_paiements TO service_role;


--
-- Name: SEQUENCE abonnement_paiements_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE ON SEQUENCE public.abonnement_paiements_id_seq TO anon;
GRANT ALL ON SEQUENCE public.abonnement_paiements_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.abonnement_paiements_id_seq TO service_role;


--
-- Name: TABLE announcements; Type: ACL; Schema: public; Owner: postgres
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.announcements TO anon;
GRANT ALL ON TABLE public.announcements TO authenticated;
GRANT ALL ON TABLE public.announcements TO service_role;


--
-- Name: SEQUENCE announcements_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE ON SEQUENCE public.announcements_id_seq TO anon;
GRANT ALL ON SEQUENCE public.announcements_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.announcements_id_seq TO service_role;


--
-- Name: TABLE audit_logs; Type: ACL; Schema: public; Owner: postgres
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.audit_logs TO anon;
GRANT ALL ON TABLE public.audit_logs TO authenticated;
GRANT ALL ON TABLE public.audit_logs TO service_role;


--
-- Name: SEQUENCE audit_logs_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE ON SEQUENCE public.audit_logs_id_seq TO anon;
GRANT ALL ON SEQUENCE public.audit_logs_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.audit_logs_id_seq TO service_role;


--
-- Name: TABLE biens; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.biens TO authenticated;
GRANT ALL ON TABLE public.biens TO service_role;


--
-- Name: COLUMN biens.nom; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(nom) ON TABLE public.biens TO authenticated;


--
-- Name: COLUMN biens.type; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(type) ON TABLE public.biens TO authenticated;


--
-- Name: COLUMN biens.adresse; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(adresse) ON TABLE public.biens TO authenticated;


--
-- Name: COLUMN biens.ville; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(ville) ON TABLE public.biens TO authenticated;


--
-- Name: COLUMN biens.pays; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(pays) ON TABLE public.biens TO authenticated;


--
-- Name: COLUMN biens.description; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(description) ON TABLE public.biens TO authenticated;


--
-- Name: SEQUENCE biens_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.biens_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.biens_id_seq TO service_role;


--
-- Name: TABLE employes; Type: ACL; Schema: public; Owner: postgres
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.employes TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.employes TO authenticated;
GRANT ALL ON TABLE public.employes TO service_role;


--
-- Name: TABLE employes_biens; Type: ACL; Schema: public; Owner: postgres
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.employes_biens TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.employes_biens TO authenticated;
GRANT ALL ON TABLE public.employes_biens TO service_role;


--
-- Name: SEQUENCE employes_biens_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE ON SEQUENCE public.employes_biens_id_seq TO anon;
GRANT ALL ON SEQUENCE public.employes_biens_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.employes_biens_id_seq TO service_role;


--
-- Name: SEQUENCE employes_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE ON SEQUENCE public.employes_id_seq TO anon;
GRANT ALL ON SEQUENCE public.employes_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.employes_id_seq TO service_role;


--
-- Name: TABLE featured_items; Type: ACL; Schema: public; Owner: postgres
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.featured_items TO anon;
GRANT ALL ON TABLE public.featured_items TO authenticated;
GRANT ALL ON TABLE public.featured_items TO service_role;


--
-- Name: SEQUENCE featured_items_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE ON SEQUENCE public.featured_items_id_seq TO anon;
GRANT ALL ON SEQUENCE public.featured_items_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.featured_items_id_seq TO service_role;


--
-- Name: TABLE incidents; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.incidents TO authenticated;
GRANT ALL ON TABLE public.incidents TO service_role;


--
-- Name: COLUMN incidents.logement_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(logement_id) ON TABLE public.incidents TO authenticated;


--
-- Name: COLUMN incidents.titre; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(titre) ON TABLE public.incidents TO authenticated;


--
-- Name: COLUMN incidents.description; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(description) ON TABLE public.incidents TO authenticated;


--
-- Name: COLUMN incidents.statut; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(statut) ON TABLE public.incidents TO authenticated;


--
-- Name: COLUMN incidents.photo; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(photo) ON TABLE public.incidents TO authenticated;


--
-- Name: SEQUENCE incidents_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.incidents_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.incidents_id_seq TO service_role;


--
-- Name: TABLE interventions; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.interventions TO authenticated;
GRANT ALL ON TABLE public.interventions TO service_role;


--
-- Name: COLUMN interventions.incident_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(incident_id) ON TABLE public.interventions TO authenticated;


--
-- Name: COLUMN interventions.prestataire_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(prestataire_id) ON TABLE public.interventions TO authenticated;


--
-- Name: COLUMN interventions.logement_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(logement_id) ON TABLE public.interventions TO authenticated;


--
-- Name: COLUMN interventions.titre; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(titre) ON TABLE public.interventions TO authenticated;


--
-- Name: COLUMN interventions.description; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(description) ON TABLE public.interventions TO authenticated;


--
-- Name: COLUMN interventions.statut; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(statut) ON TABLE public.interventions TO authenticated;


--
-- Name: COLUMN interventions.date_prevue; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(date_prevue) ON TABLE public.interventions TO authenticated;


--
-- Name: SEQUENCE interventions_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.interventions_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.interventions_id_seq TO service_role;


--
-- Name: TABLE locataires; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.locataires TO authenticated;
GRANT ALL ON TABLE public.locataires TO service_role;


--
-- Name: COLUMN locataires.account_uid; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(account_uid) ON TABLE public.locataires TO authenticated;


--
-- Name: COLUMN locataires.logement_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(logement_id) ON TABLE public.locataires TO authenticated;


--
-- Name: COLUMN locataires.nom; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(nom) ON TABLE public.locataires TO authenticated;


--
-- Name: COLUMN locataires.email; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(email) ON TABLE public.locataires TO authenticated;


--
-- Name: COLUMN locataires.phone; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(phone) ON TABLE public.locataires TO authenticated;


--
-- Name: COLUMN locataires.date_entree; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(date_entree) ON TABLE public.locataires TO authenticated;


--
-- Name: COLUMN locataires.statut; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(statut) ON TABLE public.locataires TO authenticated;


--
-- Name: COLUMN locataires.jour_echeance; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(jour_echeance) ON TABLE public.locataires TO authenticated;


--
-- Name: COLUMN locataires.bien_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(bien_id) ON TABLE public.locataires TO authenticated;


--
-- Name: SEQUENCE locataires_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.locataires_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.locataires_id_seq TO service_role;


--
-- Name: TABLE logements; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.logements TO authenticated;
GRANT ALL ON TABLE public.logements TO service_role;


--
-- Name: COLUMN logements.bien_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(bien_id) ON TABLE public.logements TO authenticated;


--
-- Name: COLUMN logements.nom; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(nom) ON TABLE public.logements TO authenticated;


--
-- Name: COLUMN logements.loyer_mensuel; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(loyer_mensuel) ON TABLE public.logements TO authenticated;


--
-- Name: COLUMN logements.statut; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(statut) ON TABLE public.logements TO authenticated;


--
-- Name: COLUMN logements.description; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(description) ON TABLE public.logements TO authenticated;


--
-- Name: COLUMN logements.type; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(type) ON TABLE public.logements TO authenticated;


--
-- Name: COLUMN logements.nombre_chambres; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(nombre_chambres) ON TABLE public.logements TO authenticated;


--
-- Name: COLUMN logements.adresse; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(adresse) ON TABLE public.logements TO authenticated;


--
-- Name: SEQUENCE logements_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.logements_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.logements_id_seq TO service_role;


--
-- Name: TABLE moyens_paiement; Type: ACL; Schema: public; Owner: postgres
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.moyens_paiement TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.moyens_paiement TO authenticated;
GRANT ALL ON TABLE public.moyens_paiement TO service_role;


--
-- Name: TABLE moyens_paiement_employes; Type: ACL; Schema: public; Owner: postgres
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.moyens_paiement_employes TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.moyens_paiement_employes TO authenticated;
GRANT ALL ON TABLE public.moyens_paiement_employes TO service_role;


--
-- Name: SEQUENCE moyens_paiement_employes_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE ON SEQUENCE public.moyens_paiement_employes_id_seq TO anon;
GRANT ALL ON SEQUENCE public.moyens_paiement_employes_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.moyens_paiement_employes_id_seq TO service_role;


--
-- Name: SEQUENCE moyens_paiement_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE ON SEQUENCE public.moyens_paiement_id_seq TO anon;
GRANT ALL ON SEQUENCE public.moyens_paiement_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.moyens_paiement_id_seq TO service_role;


--
-- Name: TABLE notifications; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.notifications TO authenticated;
GRANT ALL ON TABLE public.notifications TO service_role;


--
-- Name: COLUMN notifications.lu; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(lu) ON TABLE public.notifications TO authenticated;


--
-- Name: SEQUENCE notifications_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.notifications_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.notifications_id_seq TO service_role;


--
-- Name: TABLE paiements; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.paiements TO authenticated;
GRANT ALL ON TABLE public.paiements TO service_role;


--
-- Name: COLUMN paiements.locataire_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(locataire_id) ON TABLE public.paiements TO authenticated;


--
-- Name: COLUMN paiements.logement_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(logement_id) ON TABLE public.paiements TO authenticated;


--
-- Name: COLUMN paiements.montant; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(montant) ON TABLE public.paiements TO authenticated;


--
-- Name: COLUMN paiements.mois; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(mois) ON TABLE public.paiements TO authenticated;


--
-- Name: COLUMN paiements.statut; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(statut) ON TABLE public.paiements TO authenticated;


--
-- Name: COLUMN paiements.date_paiement; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(date_paiement) ON TABLE public.paiements TO authenticated;


--
-- Name: COLUMN paiements.methode_paiement; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(methode_paiement) ON TABLE public.paiements TO authenticated;


--
-- Name: COLUMN paiements.reference; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(reference) ON TABLE public.paiements TO authenticated;


--
-- Name: TABLE paiements_employes; Type: ACL; Schema: public; Owner: postgres
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.paiements_employes TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.paiements_employes TO authenticated;
GRANT ALL ON TABLE public.paiements_employes TO service_role;


--
-- Name: SEQUENCE paiements_employes_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE ON SEQUENCE public.paiements_employes_id_seq TO anon;
GRANT ALL ON SEQUENCE public.paiements_employes_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.paiements_employes_id_seq TO service_role;


--
-- Name: SEQUENCE paiements_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.paiements_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.paiements_id_seq TO service_role;


--
-- Name: TABLE platform_events; Type: ACL; Schema: public; Owner: postgres
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.platform_events TO anon;
GRANT ALL ON TABLE public.platform_events TO authenticated;
GRANT ALL ON TABLE public.platform_events TO service_role;


--
-- Name: SEQUENCE platform_events_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE ON SEQUENCE public.platform_events_id_seq TO anon;
GRANT ALL ON SEQUENCE public.platform_events_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.platform_events_id_seq TO service_role;


--
-- Name: TABLE prestataires; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.prestataires TO authenticated;
GRANT ALL ON TABLE public.prestataires TO service_role;


--
-- Name: COLUMN prestataires.nom; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(nom) ON TABLE public.prestataires TO authenticated;


--
-- Name: COLUMN prestataires.specialite; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(specialite) ON TABLE public.prestataires TO authenticated;


--
-- Name: COLUMN prestataires.phone; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(phone) ON TABLE public.prestataires TO authenticated;


--
-- Name: COLUMN prestataires.email; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(email) ON TABLE public.prestataires TO authenticated;


--
-- Name: SEQUENCE prestataires_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.prestataires_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.prestataires_id_seq TO service_role;


--
-- Name: TABLE profiles; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;


--
-- Name: COLUMN profiles.name; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(name) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.phone; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(phone) ON TABLE public.profiles TO authenticated;


--
-- Name: TABLE sessions; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.sessions TO authenticated;
GRANT ALL ON TABLE public.sessions TO service_role;


--
-- Name: SEQUENCE sessions_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.sessions_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.sessions_id_seq TO service_role;


--
-- Name: TABLE subscriptions; Type: ACL; Schema: public; Owner: postgres
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.subscriptions TO anon;
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.subscriptions TO authenticated;
GRANT ALL ON TABLE public.subscriptions TO service_role;


--
-- Name: TABLE system_config; Type: ACL; Schema: public; Owner: postgres
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.system_config TO anon;
GRANT ALL ON TABLE public.system_config TO authenticated;
GRANT ALL ON TABLE public.system_config TO service_role;


--
-- Name: TABLE tasks; Type: ACL; Schema: public; Owner: postgres
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.tasks TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.tasks TO authenticated;
GRANT ALL ON TABLE public.tasks TO service_role;


--
-- Name: SEQUENCE tasks_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE ON SEQUENCE public.tasks_id_seq TO anon;
GRANT ALL ON SEQUENCE public.tasks_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.tasks_id_seq TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT UPDATE ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT UPDATE ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT UPDATE ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--

\unrestrict tfK58Aw0wHzfDDK59cFFXmKCOWQ3faydUlyJjf5lERIubbpAEEZy4Uus5e8MfeR

