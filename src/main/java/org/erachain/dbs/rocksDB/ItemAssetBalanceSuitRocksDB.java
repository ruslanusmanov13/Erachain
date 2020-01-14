package org.erachain.dbs.rocksDB;

import com.google.common.primitives.Longs;
import lombok.extern.slf4j.Slf4j;
import org.erachain.controller.Controller;
import org.erachain.core.account.Account;
import org.erachain.database.DBASet;
import org.erachain.datachain.ItemAssetBalanceSuit;
import org.erachain.dbs.DBTab;
import org.erachain.dbs.IteratorCloseable;
import org.erachain.dbs.IteratorCloseableImpl;
import org.erachain.dbs.rocksDB.indexes.SimpleIndexDB;
import org.erachain.dbs.rocksDB.indexes.indexByteables.IndexByteableBigDecimal;
import org.erachain.dbs.rocksDB.integration.DBRocksDBTable;
import org.erachain.dbs.rocksDB.integration.DBRocksDBTableDBCommitedAsBath;
import org.erachain.dbs.rocksDB.transformation.ByteableTrivial;
import org.mapdb.DB;
import org.mapdb.Fun.Tuple2;
import org.mapdb.Fun.Tuple5;
import org.rocksdb.ReadOptions;
import org.rocksdb.RocksIterator;
import org.rocksdb.WriteOptions;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

import static org.erachain.utils.ByteArrayUtils.areEqualMask;

@Slf4j
public class ItemAssetBalanceSuitRocksDB extends DBMapSuit<byte[], Tuple5<
        Tuple2<BigDecimal, BigDecimal>, // in OWN - total INCOMED + BALANCE
        Tuple2<BigDecimal, BigDecimal>, // in DEBT
        Tuple2<BigDecimal, BigDecimal>, // in STOCK
        Tuple2<BigDecimal, BigDecimal>, // it DO
        Tuple2<BigDecimal, BigDecimal>  // on HOLD
        >>
            implements ItemAssetBalanceSuit {

    private IndexByteableBigDecimal seralizerBigDecimal = new IndexByteableBigDecimal();
    private final String NAME_TABLE = "ITEM_ASSET_BALANCE_TABLE";
    private final String balanceKeyAssetIndexName = "balances_by_asset";
    private final String balanceAddressIndexName = "balances_by_address";
    private SimpleIndexDB<
            byte[],
            Tuple5<
                    Tuple2<BigDecimal, BigDecimal>,
                    Tuple2<BigDecimal, BigDecimal>,
                    Tuple2<BigDecimal, BigDecimal>,
                    Tuple2<BigDecimal, BigDecimal>,
                    Tuple2<BigDecimal, BigDecimal>>,
            byte[]> balanceKeyAssetIndex;

    private SimpleIndexDB<
            byte[],
            Tuple5<
                    Tuple2<BigDecimal, BigDecimal>,
                    Tuple2<BigDecimal, BigDecimal>,
                    Tuple2<BigDecimal, BigDecimal>,
                    Tuple2<BigDecimal, BigDecimal>,
                    Tuple2<BigDecimal, BigDecimal>>,
            byte[]> balanceAddressIndex;

    public ItemAssetBalanceSuitRocksDB(DBASet databaseSet, DB database, DBTab cover) {
        super(databaseSet, database, logger, false, cover);
    }

    @Override
    public void openMap() {

        map = new DBRocksDBTableDBCommitedAsBath<byte[], Tuple5<
                        Tuple2<BigDecimal, BigDecimal>, // in OWN - total INCOMED + BALANCE
                        Tuple2<BigDecimal, BigDecimal>, // in DEBT
                        Tuple2<BigDecimal, BigDecimal>, // in STOCK
                        Tuple2<BigDecimal, BigDecimal>, // it DO
                        Tuple2<BigDecimal, BigDecimal>  // on HOLD
                        >>(
                new ByteableTrivial(),
                new org.erachain.dbs.rocksDB.transformation.differentLength.ByteableTuple5Tuples2BigDecimal(), NAME_TABLE, indexes,
                org.erachain.dbs.rocksDB.common.RocksDbSettings.initCustomSettings(7, 64, 32,
                        256, 128,
                        1, 256, 32, false),
                new WriteOptions().setSync(true).setDisableWAL(false),
                new ReadOptions(),
                databaseSet, sizeEnable);

    }

    @Override
    public void createIndexes() {

        // indexes = new ArrayList<>(); - null - not use SIZE index and counter

        if (Controller.getInstance().onlyProtocolIndexing)
            // NOT USE SECONDARY INDEXES
            return;

        balanceKeyAssetIndex = new SimpleIndexDB<>(balanceKeyAssetIndexName,
                (key, value) -> {
                    // Address
                    byte[] shortAddress = new byte[20];
                    System.arraycopy(key, 0, shortAddress, 0, 20);
                    // ASSET KEY
                    byte[] assetKeyBytes = new byte[8];
                    System.arraycopy(key, 20, assetKeyBytes, 0, 8);

                    byte[] shiftForSortBuff;
                    shiftForSortBuff = seralizerBigDecimal.toBytes(value.a.b.negate());

                    return org.bouncycastle.util.Arrays.concatenate(
                            assetKeyBytes,
                            shiftForSortBuff
                            //shortAddress - он уже есть в главном ключе
                    );
                },
                (result) -> result);

        balanceAddressIndex = new SimpleIndexDB<>(balanceAddressIndexName,
                (key, value) -> {
                    // Address
                    byte[] shortAddress = new byte[20];
                    System.arraycopy(key, 0, shortAddress, 0, 20);
                    // ASSET KEY
                    byte[] assetKeyBytes = new byte[8];
                    System.arraycopy(key, 20, assetKeyBytes, 0, 8);

                    return org.bouncycastle.util.Arrays.concatenate(
                            shortAddress,
                            assetKeyBytes);
                },
                (result) -> result); // ByteableTrivial

        indexes = new ArrayList<>();
        indexes.add(balanceKeyAssetIndex);
        indexes.add(balanceAddressIndex);
    }

    // TODO - release it on Iterators

    public Set<byte[]> assetKeys(long assetKey) {
        return ((DBRocksDBTable)map).filterAppropriateValuesAsByteKeys(
                Longs.toByteArray(assetKey),
                balanceKeyAssetIndex.getColumnFamilyHandle());
    }

    @Override
    public IteratorCloseable<byte[]> assetIterator(long assetKey) {
        return new IteratorCloseableImpl(assetKeys(assetKey).iterator());
    }

    public List<byte[]> accountKeys(Account account) {

        List<byte[]> result = new ArrayList<>();

        try (final RocksIterator iterator = map.dbSource.getDbCore().newIterator(
                balanceAddressIndex.getColumnFamilyHandle())) {
            for (iterator.seek(account.getShortAddressBytes()); iterator.isValid()
                    && areEqualMask(iterator.key(), account.getShortAddressBytes()); iterator.next()) {
                result.add(iterator.value());
            }
        }

        return result;
    }

    @Override
    public IteratorCloseable<byte[]> accountIterator(Account account) {
        return ((DBRocksDBTable) map).getIndexIteratorFilter(balanceAddressIndex.getColumnFamilyHandle(), account.getShortAddressBytes(), false, true);
    }

}