import logger from '../../utils/logger.js';
import {
  rawLcaRequestSchema,
  type ActivityCategory,
  type CanonicalDataSourceKind,
  type CommitmentPreimageV1,
  type HistoricalData,
  type InputOrigin,
  type LcaResult,
  type NormalizedActivityRecord,
  type NormalizedLcaInput,
  type NormalizedSpendRecord,
  type RawLcaRequestInput,
  type SourceSummary,
  type SpendCategory,
} from './types.js';

// To convert emission factors from gCO2e/unit to kgCO2e/unit, we apply a scale of 1/1000.
// This is because the LCA calculation and resulting commitment payload use kgCO2e as the unit for emissions.
const EMISSION_FACTOR_SCALE = 0.001;

// The emission factors are based on the 3rd Basic Survey on Emissions of Greenhouse Gases by the Ministry of the Environment, Japan.
// Following values represents g-CO2 per price unit (JPY) for each category, and are converted to kg-CO2 per price unit by applying the EMISSION_FACTOR_SCALE.
const EMISSION_FACTORS = {
  spend: {
    Rice: 11.92354547 * EMISSION_FACTOR_SCALE,
    WheatBarleyAndTheLike: 18.09860021 * EMISSION_FACTOR_SCALE,
    PotatoesAndSweetPotatoes: 5.19244712 * EMISSION_FACTOR_SCALE,
    Pulses: 9.3317688 * EMISSION_FACTOR_SCALE,
    Vegetables: 4.880996223 * EMISSION_FACTOR_SCALE,
    Fruits: 4.352712854 * EMISSION_FACTOR_SCALE,
    SugarCrops: 7.402732317 * EMISSION_FACTOR_SCALE,
    CropsForBeverages: 13.26790958 * EMISSION_FACTOR_SCALE,
    MiscellaneousEdibleCrops: 12.08129272 * EMISSION_FACTOR_SCALE,
    FeedAndForageCrops: 10.87713128 * EMISSION_FACTOR_SCALE,
    SeedsAndSeedlings: 1.754516316 * EMISSION_FACTOR_SCALE,
    FlowersAndPlants: 7.361678316 * EMISSION_FACTOR_SCALE,
    MiscellaneousInedibleCrops: 3.375980439 * EMISSION_FACTOR_SCALE,
    DairyCattleFarming: 10.62621965 * EMISSION_FACTOR_SCALE,
    BeefCattle: 11.5755222 * EMISSION_FACTOR_SCALE,
    Hogs: 6.767100353 * EMISSION_FACTOR_SCALE,
    HenEggs: 5.349417862 * EMISSION_FACTOR_SCALE,
    Chickens: 5.839037819 * EMISSION_FACTOR_SCALE,
    MiscellaneousLivestock: 3.773594235 * EMISSION_FACTOR_SCALE,
    AgriculturalServices: 2.613755213 * EMISSION_FACTOR_SCALE,
    Silviculture: 0.5262358946 * EMISSION_FACTOR_SCALE,
    Logs: 2.515642019 * EMISSION_FACTOR_SCALE,
    SpecialForestProductsIncludingHunting: 3.125837152 * EMISSION_FACTOR_SCALE,
    MarineFishery: 8.943313634 * EMISSION_FACTOR_SCALE,
    MarineAquaculture: 5.065648014 * EMISSION_FACTOR_SCALE,
    InlandWaterFisheryAndInlandWaterAquaculture:
      6.492797594 * EMISSION_FACTOR_SCALE,
    CoalMiningCrudePetroleumAndNaturalGas: 13.38986584 * EMISSION_FACTOR_SCALE,
    GravelAndQuarrying: 5.743312452 * EMISSION_FACTOR_SCALE,
    MiscellaneousOres: 8.752360282 * EMISSION_FACTOR_SCALE,
    Meat: 6.670542392 * EMISSION_FACTOR_SCALE,
    DairyFarmProducts: 5.263942973 * EMISSION_FACTOR_SCALE,
    MiscellaneousLivestockProducts: 3.841553381 * EMISSION_FACTOR_SCALE,
    FrozenFishAndShellfish: 4.722275448 * EMISSION_FACTOR_SCALE,
    SaltedDriedOrSmokedSeafood: 3.626083967 * EMISSION_FACTOR_SCALE,
    BottledOrCannedSeafood: 3.814027319 * EMISSION_FACTOR_SCALE,
    FishPaste: 3.584470788 * EMISSION_FACTOR_SCALE,
    MiscellaneousProcessedSeafood: 3.340461248 * EMISSION_FACTOR_SCALE,
    GrainMilling: 10.03117017 * EMISSION_FACTOR_SCALE,
    FlourAndMiscellaneousGrainMilledProducts:
      7.087845032 * EMISSION_FACTOR_SCALE,
    Noodles: 3.684818111 * EMISSION_FACTOR_SCALE,
    Bread: 3.463234883 * EMISSION_FACTOR_SCALE,
    Confectionery: 2.677708252 * EMISSION_FACTOR_SCALE,
    PreservedAgriculturalFoodstuffs: 2.62640748 * EMISSION_FACTOR_SCALE,
    Sugar: 3.598369544 * EMISSION_FACTOR_SCALE,
    Starch: 8.04559591 * EMISSION_FACTOR_SCALE,
    DextroseSyrupAndIsomerizedSugar: 5.106636853 * EMISSION_FACTOR_SCALE,
    AnimalOilAndFatsVegetableOilAndMeal: 6.701739101 * EMISSION_FACTOR_SCALE,
    CondimentsAndSeasonings: 3.066974728 * EMISSION_FACTOR_SCALE,
    PreparedFrozenFoods: 3.946727996 * EMISSION_FACTOR_SCALE,
    RetortFoods: 2.757606693 * EMISSION_FACTOR_SCALE,
    DishesSushiAndLunchBoxes: 3.706746122 * EMISSION_FACTOR_SCALE,
    MiscellaneousFoods: 3.125791489 * EMISSION_FACTOR_SCALE,
    RefinedSake: 2.472754273 * EMISSION_FACTOR_SCALE,
    MaltLiquors: 1.2317143 * EMISSION_FACTOR_SCALE,
    WhiskeyAndBrandy: 1.148900256 * EMISSION_FACTOR_SCALE,
    MiscellaneousLiquors: 1.351346826 * EMISSION_FACTOR_SCALE,
    TeaAndRoastedCoffee: 5.799546164 * EMISSION_FACTOR_SCALE,
    SoftDrinks: 3.907028959 * EMISSION_FACTOR_SCALE,
    ManufacturedIce: 5.403297346 * EMISSION_FACTOR_SCALE,
    Feeds: 5.981026923 * EMISSION_FACTOR_SCALE,
    OrganicFertilizersNEC: 4.27713207 * EMISSION_FACTOR_SCALE,
    Tobacco: 0.6531570209 * EMISSION_FACTOR_SCALE,
    FiberYarns: 6.762340615 * EMISSION_FACTOR_SCALE,
    CottonAndStapleFiberFabricsIncludingFabricsOfSyntheticSpunFibers:
      7.014968896 * EMISSION_FACTOR_SCALE,
    SilkAndArtificialSilkFabricsIncludingFabricsOfSyntheticFilamentFibers:
      7.498356625 * EMISSION_FACTOR_SCALE,
    MiscellaneousFabrics: 6.555704365 * EMISSION_FACTOR_SCALE,
    KnittingFabrics: 5.737721231 * EMISSION_FACTOR_SCALE,
    YarnAndFabricDyeingAndFinishingProcessingOnCommissionOnly:
      5.907685935 * EMISSION_FACTOR_SCALE,
    MiscellaneousFabricatedTextileProducts: 6.099869011 * EMISSION_FACTOR_SCALE,
    WovenFabricApparel: 3.020592817 * EMISSION_FACTOR_SCALE,
    KnittedApparel: 4.688810542 * EMISSION_FACTOR_SCALE,
    MiscellaneousWearingApparelAndClothingAccessories:
      4.211777965 * EMISSION_FACTOR_SCALE,
    Bedding: 3.435076966 * EMISSION_FACTOR_SCALE,
    CarpetsAndFloorMats: 7.937884744 * EMISSION_FACTOR_SCALE,
    MiscellaneousReadyMadeTextileProducts: 3.901367252 * EMISSION_FACTOR_SCALE,
    Timber: 2.097972161 * EMISSION_FACTOR_SCALE,
    PlywoodGluedLaminatedTimber: 2.155046282 * EMISSION_FACTOR_SCALE,
    WoodenChips: 3.020356584 * EMISSION_FACTOR_SCALE,
    MiscellaneousWoodenProducts: 2.383999035 * EMISSION_FACTOR_SCALE,
    WoodenFurniture: 1.964937372 * EMISSION_FACTOR_SCALE,
    MetallicFurniture: 4.583990757 * EMISSION_FACTOR_SCALE,
    WoodenFixtures: 1.879664888 * EMISSION_FACTOR_SCALE,
    MiscellaneousFurnitureAndFixtures: 3.112112716 * EMISSION_FACTOR_SCALE,
    Pulp: 18.0220061 * EMISSION_FACTOR_SCALE,
    Paper: 13.5131753 * EMISSION_FACTOR_SCALE,
    Paperboard: 14.09611853 * EMISSION_FACTOR_SCALE,
    CorrugatedCardboard: 8.165338397 * EMISSION_FACTOR_SCALE,
    CoatedPaperAndBuildingConstructionPaper:
      4.894059225 * EMISSION_FACTOR_SCALE,
    CorrugatedCardBoardBoxes: 3.470695463 * EMISSION_FACTOR_SCALE,
    MiscellaneousPaperContainers: 4.729684078 * EMISSION_FACTOR_SCALE,
    PaperTextileForMedicalUse: 3.918526736 * EMISSION_FACTOR_SCALE,
    MiscellaneousPulpPaperAndProcessedPaperProducts:
      4.387343139 * EMISSION_FACTOR_SCALE,
    PrintingPlateMakingAndBookBinding: 3.03258108 * EMISSION_FACTOR_SCALE,
    ChemicalFertilizer: 16.87795224 * EMISSION_FACTOR_SCALE,
    IndustrialSodaChemicals: 14.89457756 * EMISSION_FACTOR_SCALE,
    InorganicPigment: 12.1446972 * EMISSION_FACTOR_SCALE,
    CompressedGasAndLiquefiedGas: 12.75486967 * EMISSION_FACTOR_SCALE,
    Salt: 6.68660253 * EMISSION_FACTOR_SCALE,
    MiscellaneousIndustrialInorganicChemicals:
      4.798139771 * EMISSION_FACTOR_SCALE,
    PetrochemicalBasicProducts: 20.89032064 * EMISSION_FACTOR_SCALE,
    PetrochemicalAromaticProductsExceptSyntheticResin:
      16.94024459 * EMISSION_FACTOR_SCALE,
    AliphaticIntermediates: 16.78282859 * EMISSION_FACTOR_SCALE,
    CyclicIntermediatesSyntheticDyesAndOrganicPigments:
      15.86327547 * EMISSION_FACTOR_SCALE,
    SyntheticRubber: 16.12108755 * EMISSION_FACTOR_SCALE,
    MethaneDerivatives: 8.992844519 * EMISSION_FACTOR_SCALE,
    Plasticizers: 8.138073685 * EMISSION_FACTOR_SCALE,
    MiscellaneousIndustrialOrganicChemicals:
      9.524669684 * EMISSION_FACTOR_SCALE,
    ThermoSettingResins: 9.512631517 * EMISSION_FACTOR_SCALE,
    ThermoplasticsResins: 11.77294118 * EMISSION_FACTOR_SCALE,
    HighFunctionResins: 8.82439932 * EMISSION_FACTOR_SCALE,
    MiscellaneousSyntheticResins: 10.5596306 * EMISSION_FACTOR_SCALE,
    ChemicalFibers: 21.28504133 * EMISSION_FACTOR_SCALE,
    Medicines: 2.949538166 * EMISSION_FACTOR_SCALE,
    OilAndFatProductsAndSurfaceActiveAgents:
      4.684770453 * EMISSION_FACTOR_SCALE,
    CosmeticsToiletPreparationsAndDentifrices:
      2.62639714 * EMISSION_FACTOR_SCALE,
    PaintAndVarnishes: 7.993314354 * EMISSION_FACTOR_SCALE,
    PrintingInk: 5.730263888 * EMISSION_FACTOR_SCALE,
    AgriculturalChemicals: 3.340163843 * EMISSION_FACTOR_SCALE,
    GelatinAndAdhesives: 4.542759573 * EMISSION_FACTOR_SCALE,
    PhotographicSensitiveMaterials: 3.337646017 * EMISSION_FACTOR_SCALE,
    MiscellaneousFinalChemicalProducts: 5.05408055 * EMISSION_FACTOR_SCALE,
    PetroleumRefineryProductsIncludingGreases:
      10.01258791 * EMISSION_FACTOR_SCALE,
    CoalProducts: 25.45052561 * EMISSION_FACTOR_SCALE,
    PavingMaterials: 6.703726198 * EMISSION_FACTOR_SCALE,
    PlasticProducts: 4.287992244 * EMISSION_FACTOR_SCALE,
    TiresAndInnerTubes: 4.950823138 * EMISSION_FACTOR_SCALE,
    MiscellaneousRubberProducts: 2.970643582 * EMISSION_FACTOR_SCALE,
    LeatherFootwear: 1.677484847 * EMISSION_FACTOR_SCALE,
    LeatherTanningLeatherProductsAndFurSkinsExceptLeatherFootwear:
      2.196189624 * EMISSION_FACTOR_SCALE,
    SheetGlassAndSafetyGlass: 4.171713966 * EMISSION_FACTOR_SCALE,
    GlassFiberAndGlassFiberProductsNEC: 4.908306671 * EMISSION_FACTOR_SCALE,
    MiscellaneousGlassProducts: 4.261201749 * EMISSION_FACTOR_SCALE,
    Cement: 111.6256884 * EMISSION_FACTOR_SCALE,
    ReadyMixedConcrete: 23.29715277 * EMISSION_FACTOR_SCALE,
    CementProducts: 8.426477329 * EMISSION_FACTOR_SCALE,
    PotteryChinaAndEarthenware: 6.912761042 * EMISSION_FACTOR_SCALE,
    ClayRefractories: 6.200425417 * EMISSION_FACTOR_SCALE,
    MiscellaneousStructuralClayProducts: 8.892756318 * EMISSION_FACTOR_SCALE,
    CarbonAndGraphiteProducts: 8.575711813 * EMISSION_FACTOR_SCALE,
    AbrasiveAndItsProducts: 4.08100739 * EMISSION_FACTOR_SCALE,
    MiscellaneousCeramicStoneAndClayProducts:
      9.51642859 * EMISSION_FACTOR_SCALE,
    PigIron: 54.40517155 * EMISSION_FACTOR_SCALE,
    FerroAlloys: 21.73461216 * EMISSION_FACTOR_SCALE,
    CrudeSteelConverters: 36.64148804 * EMISSION_FACTOR_SCALE,
    CrudeSteelElectricFurnaces: 14.88730384 * EMISSION_FACTOR_SCALE,
    ScrapIron: 0 * EMISSION_FACTOR_SCALE,
    HotRolledSteel: 24.48838019 * EMISSION_FACTOR_SCALE,
    SteelPipesAndTubes: 12.90038137 * EMISSION_FACTOR_SCALE,
    ColdFinishedSteel: 15.11592086 * EMISSION_FACTOR_SCALE,
    CoatedSteel: 10.09288093 * EMISSION_FACTOR_SCALE,
    CastAndForgedSteel: 11.55340218 * EMISSION_FACTOR_SCALE,
    CastIronPipesAndTubes: 6.887853481 * EMISSION_FACTOR_SCALE,
    CastAndForgedMaterialsIron: 13.91391143 * EMISSION_FACTOR_SCALE,
    IronAndSteelShearingAndSlitting: 14.77730848 * EMISSION_FACTOR_SCALE,
    MiscellaneousIronOrSteelProducts: 21.761351 * EMISSION_FACTOR_SCALE,
    Copper: 7.305626895 * EMISSION_FACTOR_SCALE,
    LeadAndZincIncludingRegeneratedLead: 8.128325402 * EMISSION_FACTOR_SCALE,
    AluminumIncludingRegeneratedAluminum: 4.178021372 * EMISSION_FACTOR_SCALE,
    MiscellaneousNonFerrousMetals: 3.949162513 * EMISSION_FACTOR_SCALE,
    NonFerrousMetalScrap: 0 * EMISSION_FACTOR_SCALE,
    ElectricWiresAndCables: 5.116736541 * EMISSION_FACTOR_SCALE,
    OpticalFiberCables: 4.148591339 * EMISSION_FACTOR_SCALE,
    RolledAndDrawnCopperAndCopperAlloys: 4.973848055 * EMISSION_FACTOR_SCALE,
    RolledAndDrawnAluminum: 2.898733832 * EMISSION_FACTOR_SCALE,
    NonFerrousMetalCastingsAndForgings: 4.763322877 * EMISSION_FACTOR_SCALE,
    NuclearFuels: 1.172989526 * EMISSION_FACTOR_SCALE,
    MiscellaneousNonFerrousMetalProducts: 3.524013149 * EMISSION_FACTOR_SCALE,
    FabricatedConstructionUseMetalProducts: 6.932975243 * EMISSION_FACTOR_SCALE,
    FabricatedArchitecturalMetalProducts: 4.181528261 * EMISSION_FACTOR_SCALE,
    GasAndOilAppliancesHeatingAndCookingApparatus:
      5.134391247 * EMISSION_FACTOR_SCALE,
    BoltsNutsRivetsAndSprings: 6.538988285 * EMISSION_FACTOR_SCALE,
    MetalContainersFabricatedPlateAndSheetMetal:
      4.64287224 * EMISSION_FACTOR_SCALE,
    PlumbingAccessoriesPowderMetallurgyProductsAndTools:
      3.83164745 * EMISSION_FACTOR_SCALE,
    MiscellaneousMetalProducts: 4.716378756 * EMISSION_FACTOR_SCALE,
    Boilers: 2.219480101 * EMISSION_FACTOR_SCALE,
    Turbines: 3.789506008 * EMISSION_FACTOR_SCALE,
    Engines: 3.808299691 * EMISSION_FACTOR_SCALE,
    PumpsAndCompressors: 3.151625769 * EMISSION_FACTOR_SCALE,
    Conveyors: 3.266915473 * EMISSION_FACTOR_SCALE,
    RefrigeratorsAndAirConditioningApparatus:
      25.15148218 * EMISSION_FACTOR_SCALE,
    Bearings: 4.917695176 * EMISSION_FACTOR_SCALE,
    MiscellaneousGeneralPurposeMachinery: 3.513255586 * EMISSION_FACTOR_SCALE,
    MachineryForAgriculturalUse: 3.072671776 * EMISSION_FACTOR_SCALE,
    MachineryAndEquipmentForConstructionAndMining:
      3.327782292 * EMISSION_FACTOR_SCALE,
    TextileMachinery: 3.121149708 * EMISSION_FACTOR_SCALE,
    DailyLivesIndustryMachinery: 3.062063242 * EMISSION_FACTOR_SCALE,
    ChemicalMachinery: 2.395936753 * EMISSION_FACTOR_SCALE,
    CastingEquipmentAndPlasticProcessingMachinery:
      2.769706845 * EMISSION_FACTOR_SCALE,
    MetalMachineTools: 2.939975956 * EMISSION_FACTOR_SCALE,
    MetalProcessingMachinery: 2.923017387 * EMISSION_FACTOR_SCALE,
    MachinistsPrecisionTools: 3.198369393 * EMISSION_FACTOR_SCALE,
    SemiconductorMakingEquipment: 2.162658061 * EMISSION_FACTOR_SCALE,
    MetalMolds: 3.529541004 * EMISSION_FACTOR_SCALE,
    VacuumEquipmentAndVacuumComponent: 5.27356049 * EMISSION_FACTOR_SCALE,
    Robots: 2.78979725 * EMISSION_FACTOR_SCALE,
    MiscellaneousProductionMachinery: 3.530517513 * EMISSION_FACTOR_SCALE,
    CopyMachine: 2.862503974 * EMISSION_FACTOR_SCALE,
    MiscellaneousOfficeMachines: 2.515555894 * EMISSION_FACTOR_SCALE,
    ServiceIndustryAndAmusementMachines: 3.595148394 * EMISSION_FACTOR_SCALE,
    MeasuringInstruments: 2.012819299 * EMISSION_FACTOR_SCALE,
    MedicalInstruments: 2.705259569 * EMISSION_FACTOR_SCALE,
    OpticalInstrumentsAndLenses: 2.850872069 * EMISSION_FACTOR_SCALE,
    Ordnance: 2.41973844 * EMISSION_FACTOR_SCALE,
    SemiconductorDevices: 6.771377088 * EMISSION_FACTOR_SCALE,
    IntegratedCircuits: 3.411954759 * EMISSION_FACTOR_SCALE,
    LiquidCrystalPanel: 5.46902015 * EMISSION_FACTOR_SCALE,
    FlatPanelAndElectronTubes: 3.634117007 * EMISSION_FACTOR_SCALE,
    StorageMedia: 3.413223905 * EMISSION_FACTOR_SCALE,
    ElectricCircuit: 3.026362183 * EMISSION_FACTOR_SCALE,
    MiscellaneousElectronicComponents: 2.85060549 * EMISSION_FACTOR_SCALE,
    RotatingElectricalEquipment: 4.042774053 * EMISSION_FACTOR_SCALE,
    TransformersAndReactors: 3.589676585 * EMISSION_FACTOR_SCALE,
    RelaySwitchesAndSwitchboards: 2.978024221 * EMISSION_FACTOR_SCALE,
    WiringDevicesAndSupplies: 2.43580208 * EMISSION_FACTOR_SCALE,
    ElectricalEquipmentForInternalCombustionEngines:
      2.981319125 * EMISSION_FACTOR_SCALE,
    MiscellaneousElectricalDevicesAndParts: 4.064048013 * EMISSION_FACTOR_SCALE,
    HouseholdAirConditioners: 3.273720596 * EMISSION_FACTOR_SCALE,
    HouseholdElectricAppliancesExceptAirConditioners:
      3.358000214 * EMISSION_FACTOR_SCALE,
    AppliedElectronicEquipment: 2.65927231 * EMISSION_FACTOR_SCALE,
    ElectricMeasuringInstruments: 2.126702953 * EMISSION_FACTOR_SCALE,
    ElectricBulbs: 2.278897921 * EMISSION_FACTOR_SCALE,
    ElectricLightingFixturesAndApparatus: 2.696289926 * EMISSION_FACTOR_SCALE,
    Batteries: 3.424193013 * EMISSION_FACTOR_SCALE,
    WiredCommunicationEquipment: 2.980606404 * EMISSION_FACTOR_SCALE,
    MobilePhone: 3.256252111 * EMISSION_FACTOR_SCALE,
    RadioCommunicationEquipmentExceptMobilePhone:
      2.780141363 * EMISSION_FACTOR_SCALE,
    RadioAndTelevisionSets: 3.270446213 * EMISSION_FACTOR_SCALE,
    MiscellaneousCommunicationEquipment: 2.242092771 * EMISSION_FACTOR_SCALE,
    VideoEquipmentAndDigitalCamera: 2.959182247 * EMISSION_FACTOR_SCALE,
    ElectricAudioEquipment: 3.02443395 * EMISSION_FACTOR_SCALE,
    PersonalComputers: 2.510342851 * EMISSION_FACTOR_SCALE,
    ElectronicComputingEquipmentExceptPersonalComputers:
      2.198867971 * EMISSION_FACTOR_SCALE,
    ElectronicComputingEquipmentAccessoryEquipment:
      3.010260954 * EMISSION_FACTOR_SCALE,
    PassengerMotorCarsHybridCars: 3.262955932 * EMISSION_FACTOR_SCALE,
    PassengerMotorCarsExceptHybridCars: 3.334086073 * EMISSION_FACTOR_SCALE,
    TrucksBusesAndMiscellaneousCars: 3.463152686 * EMISSION_FACTOR_SCALE,
    TwoWheelMotorVehicles: 3.074260855 * EMISSION_FACTOR_SCALE,
    InternalCombustionEnginesForMotorVehicles:
      3.30198669 * EMISSION_FACTOR_SCALE,
    MotorVehiclePartsAndAccessories: 3.212106503 * EMISSION_FACTOR_SCALE,
    SteelShips: 8.633126263 * EMISSION_FACTOR_SCALE,
    MiscellaneousShipsExceptSteelShips: 5.208341682 * EMISSION_FACTOR_SCALE,
    InternalCombustionEnginesForVessels: 5.873976686 * EMISSION_FACTOR_SCALE,
    RepairOfShips: 5.005460819 * EMISSION_FACTOR_SCALE,
    RollingStock: 5.938023689 * EMISSION_FACTOR_SCALE,
    RepairOfRollingStock: 6.148066932 * EMISSION_FACTOR_SCALE,
    Aircrafts: 3.963797112 * EMISSION_FACTOR_SCALE,
    RepairOfAircrafts: 3.029473244 * EMISSION_FACTOR_SCALE,
    Bicycles: 6.411616931 * EMISSION_FACTOR_SCALE,
    MiscellaneousTransportEquipment: 5.296486294 * EMISSION_FACTOR_SCALE,
    ToysAndGames: 2.31354305 * EMISSION_FACTOR_SCALE,
    SportingAndAthleticGoods: 3.678023263 * EMISSION_FACTOR_SCALE,
    JewelryAndAdornments: 2.451013339 * EMISSION_FACTOR_SCALE,
    WatchesAndClocks: 2.035845459 * EMISSION_FACTOR_SCALE,
    MusicalInstruments: 2.109408233 * EMISSION_FACTOR_SCALE,
    Stationery: 2.465516251 * EMISSION_FACTOR_SCALE,
    TatamiStrawMattingAndStrawProducts: 3.194862191 * EMISSION_FACTOR_SCALE,
    AudioAndVideoRecordsOtherInformationRecordingMedia:
      1.532774102 * EMISSION_FACTOR_SCALE,
    MiscellaneousManufacturingProducts: 2.749316817 * EMISSION_FACTOR_SCALE,
    ReuseAndRecycling: 3.857199603 * EMISSION_FACTOR_SCALE,
    ResidentialConstructionWooden: 2.046680739 * EMISSION_FACTOR_SCALE,
    ResidentialConstructionNonWooden: 3.107707691 * EMISSION_FACTOR_SCALE,
    NonResidentialConstructionWooden: 2.410477496 * EMISSION_FACTOR_SCALE,
    NonResidentialConstructionNonWooden: 2.806162685 * EMISSION_FACTOR_SCALE,
    RepairOfConstruction: 2.657569355 * EMISSION_FACTOR_SCALE,
    PublicConstructionOfRoads: 3.472868843 * EMISSION_FACTOR_SCALE,
    PublicConstructionOfRiversDrainagesAndMiscellaneousPublicConstruction:
      2.823171371 * EMISSION_FACTOR_SCALE,
    AgriculturalPublicConstruction: 3.402439444 * EMISSION_FACTOR_SCALE,
    RailwayConstruction: 3.347046556 * EMISSION_FACTOR_SCALE,
    ElectricPowerFacilitiesConstruction: 2.127558234 * EMISSION_FACTOR_SCALE,
    TelecommunicationFacilitiesConstruction:
      1.619454178 * EMISSION_FACTOR_SCALE,
    MiscellaneousCivilEngineeringAndConstruction:
      3.288441828 * EMISSION_FACTOR_SCALE,
    Electricity: 26.72534593 * EMISSION_FACTOR_SCALE,
    GasSupply: 7.342969153 * EMISSION_FACTOR_SCALE,
    SteamAndHotWaterSupply: 18.91832067 * EMISSION_FACTOR_SCALE,
    WaterSupply: 1.877302575 * EMISSION_FACTOR_SCALE,
    IndustrialWaterSupply: 1.857923837 * EMISSION_FACTOR_SCALE,
    SewageDisposal: 7.030560002 * EMISSION_FACTOR_SCALE,
    WasteManagementServicesPublicCorporation:
      16.38526773 * EMISSION_FACTOR_SCALE,
    WasteManagementServices: 8.267753536 * EMISSION_FACTOR_SCALE,
    WholesaleTrade: 0.8706565105 * EMISSION_FACTOR_SCALE,
    RetailTrade: 1.591842097 * EMISSION_FACTOR_SCALE,
    FinancialService: 0.5839918303 * EMISSION_FACTOR_SCALE,
    LifeInsurance: 0.5044811332 * EMISSION_FACTOR_SCALE,
    NonLifeInsurance: 0.6629221517 * EMISSION_FACTOR_SCALE,
    RealEstateAgenciesAndManagers: 0.3605840609 * EMISSION_FACTOR_SCALE,
    RealEstateRentalService: 0.5731711679 * EMISSION_FACTOR_SCALE,
    HouseRent: 0.3763644974 * EMISSION_FACTOR_SCALE,
    HouseRentImputedHouseRent: 0.1155724638 * EMISSION_FACTOR_SCALE,
    RailwayTransportPassengers: 3.094838594 * EMISSION_FACTOR_SCALE,
    RailwayTransportFreight: 4.762606254 * EMISSION_FACTOR_SCALE,
    BusTransportService: 4.284292889 * EMISSION_FACTOR_SCALE,
    HiredCarAndTaxiTransport: 2.003682182 * EMISSION_FACTOR_SCALE,
    RoadFreightTransportExceptSelfTransport:
      4.062553337 * EMISSION_FACTOR_SCALE,
    SelfTransportPassengers: 9.092031738 * EMISSION_FACTOR_SCALE,
    SelfTransportFreight: 13.01457364 * EMISSION_FACTOR_SCALE,
    InternationalShipping: 2.129084316 * EMISSION_FACTOR_SCALE,
    CoastalAndInlandWaterTransport: 14.2610906 * EMISSION_FACTOR_SCALE,
    HarborTransportService: 1.342379779 * EMISSION_FACTOR_SCALE,
    AirTransport: 4.80446444 * EMISSION_FACTOR_SCALE,
    ConsignedFreightForwarding: 2.170994411 * EMISSION_FACTOR_SCALE,
    StorageFacilityService: 1.437916498 * EMISSION_FACTOR_SCALE,
    PackingService: 1.99704545 * EMISSION_FACTOR_SCALE,
    FacilityServiceForRoadTransport: 0.9770883705 * EMISSION_FACTOR_SCALE,
    PortAndWaterTrafficControlPublicCorporation:
      1.507750786 * EMISSION_FACTOR_SCALE,
    PortAndWaterTrafficControl: 1.086536491 * EMISSION_FACTOR_SCALE,
    ServicesRelatingToWaterTransport: 0.9107182403 * EMISSION_FACTOR_SCALE,
    AirportAndAirTrafficControlPublicCorporation:
      1.269011099 * EMISSION_FACTOR_SCALE,
    AirportAndAirTrafficControl: 1.319160633 * EMISSION_FACTOR_SCALE,
    ServicesRelatingToAirTransport: 1.450262961 * EMISSION_FACTOR_SCALE,
    TravelAgencyAndMiscellaneousServicesRelatingToTransport:
      0.8886755382 * EMISSION_FACTOR_SCALE,
    PostalServicesAndMailDelivery: 1.13554407 * EMISSION_FACTOR_SCALE,
    FixedTelecommunications: 0.9653540034 * EMISSION_FACTOR_SCALE,
    MobileTelecommunications: 0.9266934277 * EMISSION_FACTOR_SCALE,
    ServicesRelatingToTelecommunications: 0.6782085258 * EMISSION_FACTOR_SCALE,
    PublicBroadcasting: 0.7626326825 * EMISSION_FACTOR_SCALE,
    PrivateBroadcasting: 0.8200528074 * EMISSION_FACTOR_SCALE,
    CableBroadcasting: 0.7776313554 * EMISSION_FACTOR_SCALE,
    InformationServices: 0.6328044922 * EMISSION_FACTOR_SCALE,
    InternetBasedServices: 0.5803673285 * EMISSION_FACTOR_SCALE,
    VideoPictureSoundInformationCharacterInformationProductionExceptNewspaperOrPublication:
      0.9411313624 * EMISSION_FACTOR_SCALE,
    Newspaper: 3.054206861 * EMISSION_FACTOR_SCALE,
    Publication: 0.9348798051 * EMISSION_FACTOR_SCALE,
    PublicAdministrationCentralGovernment: 1.23771511 * EMISSION_FACTOR_SCALE,
    PublicAdministrationLocalGovernment: 0.9313876073 * EMISSION_FACTOR_SCALE,
    SchoolEducationPublicInstitution: 1.141810168 * EMISSION_FACTOR_SCALE,
    SchoolEducationNpi: 1.040712707 * EMISSION_FACTOR_SCALE,
    SchoolLunchPublicInstitution: 3.019113257 * EMISSION_FACTOR_SCALE,
    SchoolLunchNpi: 2.910417394 * EMISSION_FACTOR_SCALE,
    SocialEducationPublicInstitution: 2.540379998 * EMISSION_FACTOR_SCALE,
    SocialEducationNpi: 4.505693536 * EMISSION_FACTOR_SCALE,
    MiscellaneousEducationalAndTrainingInstitutionsPublicInstitution:
      3.014921015 * EMISSION_FACTOR_SCALE,
    MiscellaneousEducationalAndTrainingInstitutions:
      1.371318707 * EMISSION_FACTOR_SCALE,
    ResearchInstitutesForNaturalSciencePublicInstitution:
      1.052197181 * EMISSION_FACTOR_SCALE,
    ResearchInstitutesForCulturalAndSocialSciencePublicInstitution:
      1.040756421 * EMISSION_FACTOR_SCALE,
    ResearchInstitutesForNaturalSciencesNpi:
      0.9562370781 * EMISSION_FACTOR_SCALE,
    ResearchInstitutesForCulturalAndSocialScienceNpi:
      0.9568994907 * EMISSION_FACTOR_SCALE,
    ResearchInstitutesForNaturalSciences: 3.469070739 * EMISSION_FACTOR_SCALE,
    ResearchInstitutesForCulturalAndSocialScience:
      1.003665715 * EMISSION_FACTOR_SCALE,
    ResearchAndDevelopmentIntraEnterprise: 1.208098264 * EMISSION_FACTOR_SCALE,
    MedicalServiceGeneralHospitals: 1.303151037 * EMISSION_FACTOR_SCALE,
    MedicalServiceClinicsOfMedicalPractitioners:
      1.438618 * EMISSION_FACTOR_SCALE,
    MedicalServiceDentistry: 0.9006381901 * EMISSION_FACTOR_SCALE,
    MedicalServicePharmacies: 2.110106956 * EMISSION_FACTOR_SCALE,
    MedicalServiceMiscellaneousMedicalService:
      0.6798278694 * EMISSION_FACTOR_SCALE,
    HealthAndHygienePublicInstitution: 1.579030064 * EMISSION_FACTOR_SCALE,
    HealthAndHygiene: 0.6522248965 * EMISSION_FACTOR_SCALE,
    SocialInsurance: 2.021671754 * EMISSION_FACTOR_SCALE,
    SocialWelfarePublicInstitution: 1.050035532 * EMISSION_FACTOR_SCALE,
    SocialWelfareNpi: 1.282843989 * EMISSION_FACTOR_SCALE,
    SocialWelfare: 0.8745712736 * EMISSION_FACTOR_SCALE,
    Nursery: 1.038884993 * EMISSION_FACTOR_SCALE,
    NursingCareFacilityServices: 1.270616554 * EMISSION_FACTOR_SCALE,
    NursingCareExceptFacilityServices: 1.017147139 * EMISSION_FACTOR_SCALE,
    MembershipBasedBusinessAssociations: 1.513190174 * EMISSION_FACTOR_SCALE,
    PrivateNonProfitInstitutionsServingHouseholdsNEC:
      1.51669905 * EMISSION_FACTOR_SCALE,
    GoodsRentalAndLeasingExceptCarRental: 0.8646629225 * EMISSION_FACTOR_SCALE,
    CarRentalAndLeasing: 0.9173445753 * EMISSION_FACTOR_SCALE,
    AdvertisingServices: 0.9534959621 * EMISSION_FACTOR_SCALE,
    MotorVehicleMaintenanceServices: 1.962779831 * EMISSION_FACTOR_SCALE,
    MachineRepairServices: 2.360447022 * EMISSION_FACTOR_SCALE,
    JudicialFinancialAndAccountingServices:
      0.5329172091 * EMISSION_FACTOR_SCALE,
    CivilEngineeringAndConstructionServices:
      1.003715759 * EMISSION_FACTOR_SCALE,
    WorkerDispatchingServices: 0.07885664375 * EMISSION_FACTOR_SCALE,
    BuildingMaintenanceServices: 0.7011267498 * EMISSION_FACTOR_SCALE,
    GuardServices: 0.3752195704 * EMISSION_FACTOR_SCALE,
    SlaughterhousePublicCorporation: 2.474801147 * EMISSION_FACTOR_SCALE,
    Slaughterhouse: 3.010063692 * EMISSION_FACTOR_SCALE,
    MiscellaneousBusinessServices: 0.4359909017 * EMISSION_FACTOR_SCALE,
    Accommodations: 4.668260699 * EMISSION_FACTOR_SCALE,
    EatingAndDrinkingPlaces: 2.87358367 * EMISSION_FACTOR_SCALE,
    FoodTakeOutAndDeliveryServices: 2.335044737 * EMISSION_FACTOR_SCALE,
    Laundries: 2.694324138 * EMISSION_FACTOR_SCALE,
    BarberShops: 2.150922372 * EMISSION_FACTOR_SCALE,
    HairDressingAndBeautySalon: 1.54748545 * EMISSION_FACTOR_SCALE,
    Bathhouses: 10.71097694 * EMISSION_FACTOR_SCALE,
    MiscellaneousLaundryBeautyAndBathService:
      1.79440374 * EMISSION_FACTOR_SCALE,
    Cinemas: 4.246782115 * EMISSION_FACTOR_SCALE,
    PerformancesExceptMovieTheatersTheatricalComranies:
      1.571424812 * EMISSION_FACTOR_SCALE,
    StadiumsAndCompaniesOfBicycleHorseMotorcarAndMotorboatRaces:
      1.632999889 * EMISSION_FACTOR_SCALE,
    SportFacilityServicePublicGardensAndAmusementParks:
      1.986684358 * EMISSION_FACTOR_SCALE,
    AmusementAndRecreationFacilitiesAndServices:
      2.570455794 * EMISSION_FACTOR_SCALE,
    VeterinaryService: 1.016389648 * EMISSION_FACTOR_SCALE,
    PhotographicStudios: 1.381082635 * EMISSION_FACTOR_SCALE,
    CeremonialOccasions: 1.891495928 * EMISSION_FACTOR_SCALE,
    SupplementaryTutorialSchoolsInstructionServicesForArtsCultureAndTechnicalSkills:
      1.027363003 * EMISSION_FACTOR_SCALE,
    MiscellaneousRepairsNEC: 1.711411223 * EMISSION_FACTOR_SCALE,
    MiscellaneousPersonalServices: 1.186536769 * EMISSION_FACTOR_SCALE,
    OfficeSupplies: 4.393444897 * EMISSION_FACTOR_SCALE,
    ActivitiesNotElsewhereClassified: 1.160815572 * EMISSION_FACTOR_SCALE,
  },
  // The following activities have their own emission factors which override the spend-based emissions for specific categories.
  activity: {
    CoalMiningCrudePetroleumAndNaturalGas: 232 * EMISSION_FACTOR_SCALE,
    Electricity: 423 * EMISSION_FACTOR_SCALE, // g-CO2/kWh
    GasSupply: 0.00216 * EMISSION_FACTOR_SCALE, // g-CO2/L
    RailwayTransportPassengers: 17 * EMISSION_FACTOR_SCALE, // g-CO2/passenger-km
    BusTransportService: 57 * EMISSION_FACTOR_SCALE, // g-CO2/passenger-km
    HiredCarAndTaxiTransport: 125 * EMISSION_FACTOR_SCALE, // g-CO2/passenger-km
    SelfTransportPassengers: 125 * EMISSION_FACTOR_SCALE, // g-CO2/passenger-km
  },
} as const;

const OVERRIDDEN_SPEND_CATEGORIES_BY_ACTIVITY: Record<
  ActivityCategory,
  readonly SpendCategory[]
> = {
  Electricity: ['Electricity'],
  CoalMiningCrudePetroleumAndNaturalGas: [
    'CoalMiningCrudePetroleumAndNaturalGas',
  ],
  GasSupply: ['GasSupply'],
  RailwayTransportPassengers: ['RailwayTransportPassengers'],
  BusTransportService: ['BusTransportService'],
  HiredCarAndTaxiTransport: ['HiredCarAndTaxiTransport'],
  SelfTransportPassengers: ['SelfTransportPassengers'],
};

export interface LcaOrchestratorOptions {
  now?: () => number;
}

export class LcaOrchestrator {
  readonly #now: () => number;

  constructor(options: LcaOrchestratorOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  normalizeInput(rawPayload: RawLcaRequestInput): NormalizedLcaInput {
    logger.info(
      {
        rawPayload,
      },
      'Normalizing LCA input',
    );
    const parsed = rawLcaRequestSchema.parse(rawPayload);

    const spendData: NormalizedSpendRecord[] = [];
    const activityData: NormalizedActivityRecord[] = [];
    const origins = new Set<InputOrigin>();
    const categories = new Set<string>();

    for (const spend of parsed.spendEntries) {
      spendData.push({
        sourceId: spend.spendId,
        category: spend.category,
        amount: spend.amount,
        origin: spend.source,
      });
      origins.add(spend.source);
      categories.add(spend.category);
    }

    for (const activity of parsed.activityEntries) {
      activityData.push({
        sourceId: activity.activityId,
        category: activity.category,
        value: activity.value,
        unit: activity.unit,
        origin: activity.source,
        ...(activity.isRenewable === undefined
          ? {}
          : { isRenewable: activity.isRenewable }),
      });
      origins.add(activity.source);
      categories.add(activity.category);
    }

    const overriddenCategories = [
      ...new Set(activityData.map((activity) => activity.category)),
    ].sort() as ActivityCategory[];
    const sourceSummary: SourceSummary = {
      spendRecordCount: spendData.length,
      activityRecordCount: activityData.length,
      categories: [...categories].sort(),
      origins: [...origins].sort() as InputOrigin[],
      overriddenCategories,
    };

    return {
      ...(parsed.periodKey === undefined
        ? {}
        : { periodKey: parsed.periodKey }),
      spendData,
      activityData,
      history: parsed.history,
      dataSourceKind: deriveDataSourceKind(
        spendData.length,
        activityData.length,
        sourceSummary.origins,
      ),
      sourceSummary,
    };
  }

  // This calculation assumes that there is no duplicated activity entry of same category.
  calculateFootprint(
    spendData: NormalizedSpendRecord[],
    activityData: NormalizedActivityRecord[],
    history: HistoricalData,
  ): LcaResult {
    logger.info(
      {
        spendData,
        activityData,
        history,
      },
      'Calculating LCA footprint',
    );
    const spendEmissionsByCategory: Partial<Record<SpendCategory, number>> = {};
    let totalSpendBaseline = 0;

    for (const spend of spendData) {
      const factor = EMISSION_FACTORS.spend[spend.category];
      const emission = spend.amount * factor;
      spendEmissionsByCategory[spend.category] =
        (spendEmissionsByCategory[spend.category] ?? 0) + emission;
      totalSpendBaseline += emission;
    }

    let finalTotalEmissions = totalSpendBaseline;
    let baseReduction = 0;

    for (const activity of activityData) {
      const activityEmission = calculateActivityEmission(activity);
      const overriddenSpendCategories =
        OVERRIDDEN_SPEND_CATEGORIES_BY_ACTIVITY[activity.category];
      const overwrittenSpendEmission = overriddenSpendCategories.reduce(
        (total, category) => total + (spendEmissionsByCategory[category] ?? 0),
        0,
      );

      if (overwrittenSpendEmission > 0) {
        finalTotalEmissions =
          finalTotalEmissions - overwrittenSpendEmission + activityEmission;

        const difference = overwrittenSpendEmission - activityEmission;
        if (difference > 0) {
          baseReduction += difference;
        }

        for (const category of overriddenSpendCategories) {
          spendEmissionsByCategory[category] = 0;
        }
      } else {
        finalTotalEmissions += activityEmission;
      }
    }

    if (finalTotalEmissions <= 0) {
      finalTotalEmissions = 1;
    }

    const multiplierApplied = calculateDynamicMultiplier(
      finalTotalEmissions,
      history.pastAverageMonthlyEmissions,
    );
    const finalRewards = baseReduction * multiplierApplied;

    logger.info(
      {
        spendEmissionsByCategory,
        totalSpendBaseline,
        finalTotalEmissions,
        baseReduction,
        multiplierApplied,
        finalRewards,
      },
      'LCA calculation details',
    );

    return {
      totalEmissions: roundTo(finalTotalEmissions, 2),
      baseReduction: roundTo(baseReduction, 2),
      multiplierApplied: roundTo(multiplierApplied, 4),
      finalRewards: roundTo(finalRewards, 2),
      verificationData: {
        emissionFactorDatabase: 'EXIOBASE_Mock_v1',
        timestamp: this.#now(),
      },
    };
  }

  buildCommitmentPayload(
    result: LcaResult,
    normalizedInput: NormalizedLcaInput,
  ): CommitmentPreimageV1 {
    return {
      schemaVersion: 'commitment-preimage@v1',
      ...(normalizedInput.periodKey === undefined
        ? {}
        : { periodKey: normalizedInput.periodKey }),
      dataSourceKind: normalizedInput.dataSourceKind,
      totalEmissionsKgCo2e: result.totalEmissions,
      baseReductionKgCo2e: result.baseReduction,
      finalRewards: result.finalRewards,
      multiplierApplied: result.multiplierApplied,
      historicalBaselineKgCo2e:
        normalizedInput.history.pastAverageMonthlyEmissions,
      sourceSummary: normalizedInput.sourceSummary,
      verificationData: result.verificationData,
    };
  }
}

export function serializeCommitmentPayload(
  payload: CommitmentPreimageV1,
): string {
  return JSON.stringify(payload);
}

export function calculateDynamicMultiplier(
  currentTotalEmissions: number,
  pastAverageMonthlyEmissions: number,
): number {
  if (pastAverageMonthlyEmissions <= 0) {
    return 1;
  }

  const reductionRatio =
    (pastAverageMonthlyEmissions - currentTotalEmissions) /
    pastAverageMonthlyEmissions;
  const rawMultiplier = 1 + reductionRatio * 0.5;
  logger.info(
    {
      currentTotalEmissions,
      pastAverageMonthlyEmissions,
      reductionRatio,
      rawMultiplier,
    },
    'Calculating dynamic multiplier',
  );
  return clamp(rawMultiplier, 0.5, 1.5);
}

function calculateActivityEmission(activity: NormalizedActivityRecord): number {
  if (activity.category === 'Electricity' && activity.isRenewable) {
    return 0;
  }

  return activity.value * EMISSION_FACTORS.activity[activity.category];
}

function deriveDataSourceKind(
  spendCount: number,
  activityCount: number,
  _origins: InputOrigin[],
): CanonicalDataSourceKind {
  if (spendCount > 0 && activityCount > 0) {
    return 'hybrid';
  }

  if (activityCount > 0) {
    return 'activity';
  }

  return 'spend';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundTo(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}
