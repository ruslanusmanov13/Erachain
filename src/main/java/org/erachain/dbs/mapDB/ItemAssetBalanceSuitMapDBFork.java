package org.erachain.dbs.mapDB;

import lombok.extern.slf4j.Slf4j;
import org.erachain.core.account.Account;
import org.erachain.database.DBASet;
import org.erachain.datachain.ItemAssetBalanceMap;
import org.erachain.datachain.ItemAssetBalanceSuit;
import org.erachain.dbs.DBTab;
import org.erachain.dbs.IteratorCloseable;
import org.mapdb.*;
import org.mapdb.Fun.Tuple2;
import org.mapdb.Fun.Tuple5;

import java.math.BigDecimal;
import java.util.List;

// TODO SOFT HARD TRUE

@Slf4j
public class ItemAssetBalanceSuitMapDBFork extends DBMapSuitFork<byte[], Tuple5<
        Tuple2<BigDecimal, BigDecimal>, Tuple2<BigDecimal, BigDecimal>, Tuple2<BigDecimal, BigDecimal>,
        Tuple2<BigDecimal, BigDecimal>, Tuple2<BigDecimal, BigDecimal>>>
        implements ItemAssetBalanceSuit {

    public ItemAssetBalanceSuitMapDBFork(ItemAssetBalanceMap parent, DBASet databaseSet, DBTab cover) {
        super(parent, databaseSet, logger, false, cover);
    }

    @SuppressWarnings({"unchecked"})
    @Override
    public void openMap() {

        //OPEN MAP
        BTreeMap<byte[], Tuple5<
                Tuple2<BigDecimal, BigDecimal>, Tuple2<BigDecimal, BigDecimal>, Tuple2<BigDecimal, BigDecimal>,
                Tuple2<BigDecimal, BigDecimal>, Tuple2<BigDecimal, BigDecimal>>> treeMap;
        HTreeMap<byte[], Tuple5<
                Tuple2<BigDecimal, BigDecimal>, Tuple2<BigDecimal, BigDecimal>, Tuple2<BigDecimal, BigDecimal>,
                Tuple2<BigDecimal, BigDecimal>, Tuple2<BigDecimal, BigDecimal>>> hashMap;

        if (true) {
            hashMap = database.createHashMap("balances")
                    .keySerializer(SerializerBase.BYTE_ARRAY)
                    .hasher(Hasher.BYTE_ARRAY)
                    .makeOrGet();
            map = hashMap;
        } else {

            treeMap = database.createTreeMap("balances")
                    //.keySerializer(BTreeKeySerializer.TUPLE2)
                    .keySerializer(BTreeKeySerializer.BASIC)
                    //.keySerializer(new BTreeKeySerializer.Tuple2KeySerializer(
                    //        UnsignedBytes.lexicographicalComparator(), // Fun.BYTE_ARRAY_COMPARATOR,
                    //        Serializer.BYTE_ARRAY,
                    //        Serializer.LONG))
                    //.comparator(Fun.TUPLE2_COMPARATOR)
                    .comparator(Fun.BYTE_ARRAY_COMPARATOR)
                    //.comparator(UnsignedBytes.lexicographicalComparator())
                    .makeOrGet();
            map = treeMap;
        }

    }

    @Override
    // NOT used in FORK
    public IteratorCloseable<byte[]> assetIterator(long key) {
        return null;
    }

    @Override
    // NOT used in FORK
    public List<byte[]> assetKeys(long key) {
        return null;
    }

    @Override
    // NOT used in FORK
    public IteratorCloseable<byte[]> accountIterator(Account account) {
        return null;
    }

    @Override
    // NOT used in FORK
    public List<byte[]> accountKeys(Account account) {
        return null;
    }

}